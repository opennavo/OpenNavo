//! Automatic running-installation DAU, including background/menu-bar operation.
//! Owned by Rust so hidden/suspended WebViews cannot stop the daily tick.
use crate::{AppError, core::DesktopCore};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, sync::Arc, time::Duration};

pub const HISTORY_KEY: &str = "usage_history_v1";
const WEEK: i64 = 7 * 86_400_000;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Activity {
    anonymous_id: String,
    platform: String,
    occurred_at: DateTime<Utc>,
    version: String,
    locale: String,
}
#[derive(Debug, Serialize, Deserialize)]
struct History {
    id: String,
    sent: BTreeMap<String, String>,
    pending: Vec<Activity>,
}
fn day(now: DateTime<Utc>) -> String {
    (now + chrono::Duration::hours(8))
        .format("%Y-%m-%d")
        .to_string()
}
impl History {
    fn load(core: &DesktopCore) -> Result<Self, AppError> {
        Ok(core
            .database
            .meta(HISTORY_KEY)?
            .and_then(|value| serde_json::from_str(&value).ok())
            .unwrap_or_else(|| Self {
                id: uuid::Uuid::new_v4().to_string(),
                sent: BTreeMap::new(),
                pending: Vec::new(),
            }))
    }
    fn record(&mut self, now: DateTime<Utc>, version: &str, locale: &str) {
        let cutoff = now - chrono::Duration::milliseconds(WEEK);
        self.pending
            .retain(|a| a.occurred_at >= cutoff && a.occurred_at <= now);
        self.sent
            .retain(|date, _| date >= &day(cutoff) && date <= &day(now));
        let date = day(now);
        if self.sent.get(&date).is_some_and(|v| v == version) {
            return;
        }
        if self
            .pending
            .iter()
            .any(|a| day(a.occurred_at) == date && a.version == version)
        {
            return;
        }
        self.pending.retain(|a| day(a.occurred_at) != date);
        self.pending.push(Activity {
            anonymous_id: self.id.clone(),
            platform: "desktop".into(),
            occurred_at: now,
            version: version.into(),
            locale: locale.into(),
        });
    }
    fn acknowledge(&mut self, activity: &Activity, reporting_day: &str) {
        self.sent
            .insert(reporting_day.to_owned(), activity.version.clone());
        self.forget(activity);
    }
    /// Remove one activity the server refuses to ever accept. Keeping it at the head of the
    /// outbox would stop every later record from being sent.
    fn forget(&mut self, activity: &Activity) {
        self.pending
            .retain(|a| a.occurred_at != activity.occurred_at || a.version != activity.version);
    }
    fn save(&self, core: &DesktopCore) -> Result<(), AppError> {
        core.database
            .set_meta(HISTORY_KEY, &serde_json::to_string(self)?)
    }
}

/// One activity's result, which decides whether the tick keeps going.
enum Attempt {
    /// The server accepted the activity and named the day to acknowledge.
    Acknowledged(String),
    /// The server checked the record and refused it with 400. The same record fails the same way on
    /// every later tick, so keeping it would block everything behind it.
    Rejected,
    /// The service is unavailable, not the record: transport error, 5xx, 429, or a server too old to
    /// name the reporting day. The batch is kept for the next minute.
    Unavailable(AppError),
}

async fn attempt(client: &reqwest::Client, url: &str, activity: &Activity) -> Attempt {
    static REDIRECT_NOTICED: std::sync::Once = std::sync::Once::new();
    let response = match client.post(url).json(activity).send().await {
        Ok(response) => response,
        Err(error) => return Attempt::Unavailable(error.into()),
    };
    if response.url().as_str() != url {
        // A redirect in front of the API is followed, bounded like the catalog sync. Say it once, not
        // once a minute, so a changed endpoint stays visible without filling the log.
        REDIRECT_NOTICED.call_once(|| {
            log::info!("usage endpoint redirected to {}", response.url());
        });
    }
    let status = response.status();
    if status == reqwest::StatusCode::BAD_REQUEST {
        return Attempt::Rejected;
    }
    if status != reqwest::StatusCode::NO_CONTENT {
        return Attempt::Unavailable(
            AppError::new("E_NETWORK", "usage_unavailable")
                .with_detail(format!("status {}", status.as_u16())),
        );
    }
    match response
        .headers()
        .get("X-Usage-Day")
        .and_then(|value| value.to_str().ok())
        .filter(|value| {
            value.len() == 10 && chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok()
        }) {
        Some(day) => Attempt::Acknowledged(day.to_owned()),
        None => Attempt::Unavailable(AppError::new("E_NETWORK", "usage_day_missing")),
    }
}

async fn tick(
    core: &DesktopCore,
    client: &reqwest::Client,
    url: &str,
    now: DateTime<Utc>,
    version: &str,
) -> Result<(), AppError> {
    let mut history;
    {
        let settings = core
            .settings
            .read()
            .map_err(|_| AppError::new("E_UNKNOWN", "settings_poisoned"))?;
        history = History::load(core)?;
        history.record(now, version, settings.locale.as_str());
        history.save(core)?;
    }
    for activity in history.pending.clone() {
        match attempt(client, url, &activity).await {
            Attempt::Acknowledged(day) => {
                history.acknowledge(&activity, &day);
                history.save(core)?;
            }
            // Retaining a refused record repeats the same refusal every minute, and while it sits in
            // the outbox nothing behind it is sent: one unsendable record, such as an activity older
            // than the server's seven-day window or newer than its five-minute skew allowance, would
            // end this installation's reporting for good once the local window prunes the rest.
            // Dropping just that record keeps the remaining days and every later tick working.
            Attempt::Rejected => {
                log::warn!(
                    "usage activity rejected: occurred_at={} version={}",
                    activity.occurred_at.to_rfc3339(),
                    activity.version
                );
                history.forget(&activity);
                history.save(core)?;
            }
            Attempt::Unavailable(error) => {
                log::warn!(
                    "usage report unavailable: {} {}",
                    error.code,
                    error.detail.as_deref().unwrap_or(&error.message)
                );
                return Ok(());
            }
        }
    }
    Ok(())
}

fn build_client() -> Result<reqwest::Client, AppError> {
    Ok(reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        // Bounded like the catalog sync: a redirect placed in front of the API must not silently end
        // usage reporting while every other screen keeps working.
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()?)
}

pub fn start(core: &Arc<DesktopCore>, version: String) {
    // Development and test processes are not product usage.
    if cfg!(debug_assertions) {
        return;
    }
    let weak = Arc::downgrade(core);
    tauri::async_runtime::spawn(async move {
        let Ok(client) = build_client() else {
            log::warn!("usage client could not be created");
            return;
        };
        let url = format!(
            "{}/usage/activity",
            crate::catalog::sync::configured_base().trim_end_matches('/')
        );
        loop {
            let Some(core) = weak.upgrade() else {
                break;
            };
            if core.queue.is_stopping() {
                break;
            }
            // A failed tick keeps the outbox for the next minute; the log line is what makes a run of
            // failures visible, since nothing else in the app depends on this report.
            if let Err(error) = tick(&core, &client, &url, Utc::now(), &version).await {
                log::warn!("usage tick failed: {} ({})", error.code, error.message);
            }
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use std::io::{Read, Write};

    /// An HTTP fixture that answers up to `requests` connections and records the request bodies, so
    /// a test can see exactly which activities the client sent. It stops early rather than waiting
    /// forever for a request the client no longer makes.
    fn serve(
        requests: usize,
        answer: impl Fn(usize, &serde_json::Value) -> String + Send + 'static,
    ) -> (String, std::thread::JoinHandle<Vec<serde_json::Value>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}/usage/activity", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let mut bodies = Vec::new();
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            while bodies.len() < requests && std::time::Instant::now() < deadline {
                let mut stream = match listener.accept() {
                    Ok((stream, _)) => stream,
                    Err(_) => {
                        std::thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut buf = [0u8; 4096];
                loop {
                    let n = stream.read(&mut buf).unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&buf[..n]);
                    if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                        let header = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                        let length: usize = header
                            .lines()
                            .find_map(|line| line.strip_prefix("content-length:"))
                            .unwrap()
                            .trim()
                            .parse()
                            .unwrap();
                        if bytes.len() >= end + 4 + length {
                            let body: serde_json::Value =
                                serde_json::from_slice(&bytes[end + 4..end + 4 + length]).unwrap();
                            stream
                                .write_all(answer(bodies.len(), &body).as_bytes())
                                .unwrap();
                            bodies.push(body);
                            break;
                        }
                    }
                }
            }
            bodies
        });
        (url, server)
    }

    fn no_content(at: &serde_json::Value) -> String {
        let at: DateTime<Utc> = at["occurredAt"].as_str().unwrap().parse().unwrap();
        format!(
            "HTTP/1.1 204 No Content\r\nX-Usage-Day: {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            day(at)
        )
    }

    fn open_core(tmp: &tempfile::TempDir) -> Arc<DesktopCore> {
        DesktopCore::open(
            tmp.path().join("data"),
            tmp.path().join("cache"),
            tmp.path().join("askpass"),
            Arc::new(|_| {}),
        )
        .unwrap()
    }

    #[tokio::test]
    async fn a_rejected_activity_is_dropped_and_the_batch_continues() {
        // The server refuses a record dated in its future, as it does for a clock running more than
        // five minutes ahead. The same record fails the same way on every later tick, so it must not
        // stand between the day behind it and the server.
        let (url, server) = serve(2, |index, body| {
            assert_eq!(body.as_object().unwrap().len(), 5);
            if index == 0 {
                "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".to_owned()
            } else {
                no_content(body)
            }
        });
        let tmp = tempfile::tempdir().unwrap();
        let core = open_core(&tmp);
        let now = Utc::now();
        let id = History::load(&core).unwrap().id;
        // Today's record is the one the server refuses (a clock running ahead of the server), and the
        // record for the day before it is still waiting behind it.
        let pending = vec![
            Activity {
                anonymous_id: id.clone(),
                platform: "desktop".into(),
                occurred_at: now - chrono::Duration::seconds(1),
                version: "0.1.4".into(),
                locale: "en-US".into(),
            },
            Activity {
                anonymous_id: id.clone(),
                platform: "desktop".into(),
                occurred_at: now - chrono::Duration::days(3),
                version: "0.1.3".into(),
                locale: "en-US".into(),
            },
        ];
        History {
            id,
            sent: BTreeMap::new(),
            pending,
        }
        .save(&core)
        .unwrap();

        let client = build_client().unwrap();
        tick(&core, &client, &url, now, "0.1.4").await.unwrap();
        let delivered = server.join().unwrap();
        assert_eq!(
            delivered.len(),
            2,
            "the refused record did not end the batch"
        );
        assert_eq!(
            delivered[1]["version"], "0.1.3",
            "the record behind the rejection was sent"
        );
        let history = History::load(&core).unwrap();
        assert!(
            !history.pending.iter().any(|a| a.version == "0.1.3"),
            "the delivered record is acknowledged"
        );
        assert!(
            !history.pending.iter().any(|a| a.version == "0.1.4"),
            "the refused record is dropped rather than retried every minute"
        );

        // The next tick records the day again with its current timestamp instead of repeating the same
        // refusal, which is what keeps this installation reporting at all.
        let (url, server) = serve(1, |_, body| no_content(body));
        tick(
            &core,
            &client,
            &url,
            now + chrono::Duration::minutes(1),
            "0.1.4",
        )
        .await
        .unwrap();
        let delivered = server.join().unwrap();
        assert_eq!(
            delivered.len(),
            1,
            "the next tick is not stuck on the refused record"
        );
        assert_eq!(delivered[0]["version"], "0.1.4");
        let next = now + chrono::Duration::minutes(1);
        let at: DateTime<Utc> = delivered[0]["occurredAt"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap();
        assert!(
            at >= next && at <= next + chrono::Duration::minutes(5),
            "the next report carries the current time"
        );
        assert!(History::load(&core).unwrap().pending.is_empty());
    }

    /// A status the retry classifier treats as "the service, not the record". The client must keep the
    /// whole outbox and try again on the next tick instead of dropping anything.
    async fn an_unavailable_status_keeps_the_whole_batch(status: &'static str) {
        let (url, server) = serve(1, move |_, _| {
            format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        });
        let tmp = tempfile::tempdir().unwrap();
        let core = open_core(&tmp);
        let now = Utc::now();
        seed_two_days(&core, now);
        let client = build_client().unwrap();
        tick(&core, &client, &url, now, "0.1.4").await.unwrap();
        let delivered = server.join().unwrap();
        assert_eq!(
            delivered.len(),
            1,
            "an unavailable service stops the batch at the first record"
        );
        let history = History::load(&core).unwrap();
        assert!(
            history.sent.is_empty(),
            "no record is acknowledged by a {status}"
        );
        // Both records are still there: today's, and the one behind it the client never reached.
        for version in ["0.1.4", "0.1.3"] {
            assert!(
                history.pending.iter().any(|a| a.version == version),
                "{version} is kept for the next tick after {status}"
            );
        }

        // The next tick sends both, so nothing was lost by waiting.
        let (url, server) = serve(2, |_, body| no_content(body));
        tick(
            &core,
            &client,
            &url,
            now + chrono::Duration::minutes(1),
            "0.1.4",
        )
        .await
        .unwrap();
        let delivered = server.join().unwrap();
        assert_eq!(
            delivered.len(),
            2,
            "the next tick resends the whole batch after {status}"
        );
        assert!(History::load(&core).unwrap().pending.is_empty());
    }

    #[tokio::test]
    async fn a_server_failure_keeps_the_whole_batch() {
        an_unavailable_status_keeps_the_whole_batch("503 Service Unavailable").await;
    }

    #[tokio::test]
    async fn a_rate_limited_request_keeps_the_whole_batch() {
        // 429 is the server asking for less traffic, not refusing the record: it must be retried.
        an_unavailable_status_keeps_the_whole_batch("429 Too Many Requests").await;
    }

    #[tokio::test]
    async fn a_record_the_server_rejects_is_not_sent_again_on_the_next_tick() {
        // USAGE-039: one record the server will never accept must not become permanent silence. The
        // first tick drops it, and the next tick must not repeat it: it reports the current day only.
        let (url, server) = serve(1, |_, _| {
            "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".to_owned()
        });
        let tmp = tempfile::tempdir().unwrap();
        let core = open_core(&tmp);
        let now = Utc::now();
        seed_two_days(&core, now);
        let client = build_client().unwrap();
        tick(&core, &client, &url, now, "0.1.4").await.unwrap();
        server.join().unwrap();
        let after_rejection = History::load(&core).unwrap();
        assert!(
            !after_rejection.pending.iter().any(|a| a.version == "0.1.4"),
            "the rejected record is dropped at once"
        );
        assert!(
            after_rejection.pending.iter().any(|a| a.version == "0.1.3"),
            "the record behind the rejection is still waiting"
        );

        // Reject everything the next tick sends, so a repeated bad record would show up as another 400
        // instead of being hidden by an acknowledgement.
        let (url, server) = serve(2, |_, _| {
            "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".to_owned()
        });
        let next = now + chrono::Duration::minutes(1);
        tick(&core, &client, &url, next, "0.1.4").await.unwrap();
        let delivered = server.join().unwrap();
        let rejected_at = (now - chrono::Duration::seconds(1))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        // The rejected record is this run's `0.1.4` at `now`; the only `0.1.4` the next tick may send is
        // the fresh record it writes for the new day, dated at `next` or later.
        assert!(
            !delivered.iter().any(|body| {
                body["version"] == "0.1.4"
                    && body["occurredAt"]
                        .as_str()
                        .unwrap()
                        .parse::<DateTime<Utc>>()
                        .unwrap()
                        < next
            }),
            "the rejected 0.1.4 record at {rejected_at} is not sent again"
        );
        assert!(
            delivered.iter().any(|body| body["version"] == "0.1.3"),
            "the record behind the rejected one is reached on the next tick"
        );
        // Reporting resumes with a fresh record for the current day, which is what USAGE-039 protects:
        // dropping the one unaccepted record must not end this installation's reporting.
        assert!(
            delivered.iter().any(|body| body["version"] == "0.1.4"),
            "the next tick still reports the current day"
        );
    }

    /// A stored outbox whose first record is today's and whose second is three days old, so a test
    /// can see whether a failure at the head leaves the record behind it alone.
    fn seed_two_days(core: &DesktopCore, now: DateTime<Utc>) -> String {
        let id = History::load(core).unwrap().id;
        let pending = vec![
            Activity {
                anonymous_id: id.clone(),
                platform: "desktop".into(),
                occurred_at: now - chrono::Duration::seconds(1),
                version: "0.1.4".into(),
                locale: "en-US".into(),
            },
            Activity {
                anonymous_id: id.clone(),
                platform: "desktop".into(),
                occurred_at: now - chrono::Duration::days(3),
                version: "0.1.3".into(),
                locale: "en-US".into(),
            },
        ];
        History {
            id: id.clone(),
            sent: BTreeMap::new(),
            pending,
        }
        .save(core)
        .unwrap();
        id
    }

    #[tokio::test]
    async fn a_redirected_endpoint_is_followed() {
        let target = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let target_url = format!("http://{}/usage/activity", target.local_addr().unwrap());
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/usage/activity", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            // The API moved behind a redirect; the client must follow it rather than treat 3xx as final.
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let _ = stream.read(&mut buf).unwrap();
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 308 Permanent Redirect\r\nLocation: {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                        target_url
                    )
                    .as_bytes(),
                )
                .unwrap();
            let (mut stream, _) = target.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            loop {
                let n = stream.read(&mut buf).unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&buf[..n]);
                if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    let header = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                    let length: usize = header
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length:"))
                        .unwrap()
                        .trim()
                        .parse()
                        .unwrap();
                    if bytes.len() >= end + 4 + length {
                        let body: serde_json::Value =
                            serde_json::from_slice(&bytes[end + 4..end + 4 + length]).unwrap();
                        stream.write_all(no_content(&body).as_bytes()).unwrap();
                        return;
                    }
                }
            }
        });
        let tmp = tempfile::tempdir().unwrap();
        let core = open_core(&tmp);
        let client = build_client().unwrap();
        tick(&core, &client, &url, Utc::now(), "0.1.3")
            .await
            .unwrap();
        server.join().unwrap();
        let history = History::load(&core).unwrap();
        assert!(
            history.pending.is_empty(),
            "the redirected 204 acknowledges the record"
        );
    }

    #[test]
    fn background_daily_dedup_midnight_version_and_bounded_offline_history() {
        let mut h = History {
            id: uuid::Uuid::new_v4().to_string(),
            sent: BTreeMap::new(),
            pending: vec![],
        };
        let start = Utc.with_ymd_and_hms(2026, 10, 22, 15, 59, 0).unwrap();
        h.record(start, "0.1.3", "en-US");
        h.record(start + chrono::Duration::seconds(30), "0.1.3", "en-US");
        assert_eq!(h.pending.len(), 1);
        h.record(start + chrono::Duration::minutes(1), "0.1.3", "en-US");
        assert_eq!(h.pending.len(), 2);
        h.record(start + chrono::Duration::minutes(2), "0.1.4", "en-US");
        assert_eq!(h.pending.len(), 2);
        assert_eq!(h.pending[1].version, "0.1.4");
        h.sent.insert(day(start), "0.1.3".into());
        h.pending.remove(0);
        h.record(start, "0.1.3", "en-US");
        assert!(h.pending.is_empty()); // future-dated outbox entries are discarded after clock rollback
        for n in 0..20 {
            h.record(start + chrono::Duration::days(n), "0.1.4", "en-US");
        }
        assert!(h.pending.len() <= 8);
    }

    #[test]
    fn server_day_acknowledgement_does_not_suppress_real_midnight() {
        let mut h = History {
            id: uuid::Uuid::new_v4().to_string(),
            sent: BTreeMap::new(),
            pending: vec![],
        };
        // Actual Shanghai 23:58; the installation clock reads 00:01.
        let client = Utc.with_ymd_and_hms(2026, 10, 22, 16, 1, 0).unwrap();
        h.record(client, "0.1.3", "en-US");
        h.acknowledge(&h.pending[0].clone(), "2026-10-22");
        assert!(!h.sent.contains_key("2026-10-23"));
        h.record(client + chrono::Duration::minutes(2), "0.1.3", "en-US");
        assert_eq!(h.pending.len(), 1);
        h.acknowledge(&h.pending[0].clone(), "2026-10-23");
        h.record(client + chrono::Duration::minutes(3), "0.1.3", "en-US");
        assert!(h.pending.is_empty());
    }

    #[tokio::test]
    async fn automatic_background_report_survives_restart_and_legacy_disabled_setting() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/usage/activity", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut buf = [0u8; 4096];
            loop {
                let n = stream.read(&mut buf).unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&buf[..n]);
                if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    let header = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                    let length: usize = header
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length:"))
                        .unwrap()
                        .trim()
                        .parse()
                        .unwrap();
                    if bytes.len() >= end + 4 + length {
                        let body: serde_json::Value =
                            serde_json::from_slice(&bytes[end + 4..end + 4 + length]).unwrap();
                        assert_eq!(body["platform"], "desktop");
                        assert_eq!(body.as_object().unwrap().len(), 5);
                        let at: DateTime<Utc> =
                            body["occurredAt"].as_str().unwrap().parse().unwrap();
                        stream.write_all(format!("HTTP/1.1 204 No Content\r\nX-Usage-Day: {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", day(at)).as_bytes()).unwrap();
                        return body["anonymousId"].as_str().unwrap().to_owned();
                    }
                }
            }
        });
        let tmp = tempfile::tempdir().unwrap();
        let open = || {
            DesktopCore::open(
                tmp.path().join("data"),
                tmp.path().join("cache"),
                tmp.path().join("askpass"),
                Arc::new(|_| {}),
            )
            .unwrap()
        };
        let core = open();
        // Old persisted opt-out is no longer a supported setting.
        let mut legacy = serde_json::to_value(core.current_settings().unwrap()).unwrap();
        legacy["usageAnalytics"] = serde_json::json!(false);
        core.replace_settings(serde_json::from_value(legacy).unwrap())
            .await
            .unwrap();
        let now = Utc::now();
        let client = reqwest::Client::new();
        tick(&core, &client, &url, now, "0.1.3").await.unwrap();
        let id = server.join().unwrap();
        let restarted = open();
        assert_eq!(History::load(&restarted).unwrap().id, id);
        // The fixture server has closed. A duplicate network attempt would fail this tick.
        tick(&restarted, &client, &url, now, "0.1.3").await.unwrap();
        assert!(History::load(&restarted).unwrap().pending.is_empty());
        assert!(
            serde_json::to_value(restarted.current_settings().unwrap())
                .unwrap()
                .get("usageAnalytics")
                .is_none()
        );
    }
}
