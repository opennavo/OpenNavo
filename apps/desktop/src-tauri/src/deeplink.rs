use crate::{
    brew::args::validate_token,
    events::{CoreEvent, EventSink},
    model::*,
};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::Manager;

pub fn parse(input: &str) -> Option<DeepLinkEvent> {
    if input.len() > 8192 || input.chars().any(char::is_control) || input.trim() != input {
        return None;
    }
    let authority = input.split_once("://")?.1.split(['?', '#']).next()?;
    if let Some((_, path)) = authority.split_once('/')
        && path.split('/').any(|segment| {
            segment.is_empty() || matches!(segment, "." | "..") || segment.contains('%')
        })
    {
        return None;
    }
    let url = reqwest::Url::parse(input).ok()?;
    if url.scheme() != "opennavo"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let segments: Vec<_> = url
        .path()
        .trim_start_matches('/')
        .split('/')
        .filter(|s| !s.is_empty())
        .collect();
    if url.path().ends_with('/') && !url.path().is_empty() {
        return None;
    }
    let query: Vec<_> = url.query_pairs().collect();
    let mut action = None;
    for (name, value) in &query {
        if name == "action" {
            if action.is_some() || value != "install" {
                return None;
            }
            action = Some(DeepLinkAction::Install);
        }
    }
    let route = match url.host_str()? {
        "package" if segments.len() == 2 => {
            if !matches!(segments[0], "cask" | "formula")
                || validate_token(segments[1]).is_err()
                || query.iter().any(|(key, _)| key != "action")
            {
                return None;
            }
            format!("/package/{}/{}", segments[0], segments[1])
        }
        "collection" if segments.len() == 1 => {
            let slug = segments[0];
            let bytes = slug.as_bytes();
            if bytes.is_empty()
                || bytes.len() > 64
                || !bytes[0].is_ascii_lowercase() && !bytes[0].is_ascii_digit()
                || !bytes
                    .iter()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
                || query.iter().any(|(key, _)| key != "action")
            {
                return None;
            }
            format!("/collection/{slug}")
        }
        "search" if segments.is_empty() && action.is_none() => {
            if query.len() != 1 || query[0].0 != "q" {
                return None;
            }
            let value: String = query[0].1.chars().take(64).collect();
            let mut encoded = reqwest::Url::parse("http://localhost/").ok()?;
            encoded.query_pairs_mut().append_pair("q", &value);
            format!("/search?{}", encoded.query()?)
        }
        "updates" if segments.is_empty() && query.is_empty() => "/updates".into(),
        _ => return None,
    };
    Some(DeepLinkEvent {
        url: input.into(),
        route,
        action,
    })
}

struct State {
    ready: bool,
    pending: VecDeque<DeepLinkEvent>,
    recent: VecDeque<(String, Instant)>,
}
pub struct Router {
    state: Mutex<State>,
    sink: EventSink,
    show: Arc<dyn Fn() + Send + Sync>,
}
impl Router {
    pub fn new(sink: EventSink, show: Arc<dyn Fn() + Send + Sync>) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State {
                ready: false,
                pending: VecDeque::new(),
                recent: VecDeque::new(),
            }),
            sink,
            show,
        })
    }
    pub fn receive(&self, input: &str) {
        (self.show)();
        let Some(event) = parse(input) else {
            return;
        };
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        let now = Instant::now();
        state
            .recent
            .retain(|(_, at)| now.duration_since(*at) < Duration::from_secs(2));
        if state.recent.iter().any(|(url, _)| url == &event.url) {
            return;
        }
        if state.recent.len() >= 32 {
            state.recent.pop_front();
        }
        state.recent.push_back((event.url.clone(), now));
        if state.ready {
            drop(state);
            (self.sink)(CoreEvent::Deeplink(event));
        } else {
            if state.pending.len() >= 32 {
                state.pending.pop_front();
            }
            state.pending.push_back(event);
        }
    }
    pub fn receive_args(&self, args: &[String]) {
        let links: Vec<_> = args
            .iter()
            .filter(|arg| arg.starts_with("opennavo:"))
            .collect();
        if links.is_empty() {
            (self.show)();
        }
        for input in links {
            self.receive(input);
        }
    }
    pub fn loading(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.ready = false;
        }
    }
    pub fn ready(&self) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        state.ready = true;
        let pending: Vec<_> = state.pending.drain(..).collect();
        drop(state);
        for event in pending {
            (self.sink)(CoreEvent::Deeplink(event));
        }
    }
    pub fn navigate(&self, route: &str) {
        (self.show)();
        let event = DeepLinkEvent {
            url: format!("opennavo://{}", route.trim_start_matches('/')),
            route: route.into(),
            action: None,
        };
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if state.ready {
            drop(state);
            (self.sink)(CoreEvent::Deeplink(event));
        } else {
            if state.pending.len() >= 32 {
                state.pending.pop_front();
            }
            state.pending.push_back(event);
        }
    }
}
pub fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        // Resize to Welcome before first display to avoid flashing the full app frame.
        if app
            .try_state::<std::sync::Arc<crate::core::DesktopCore>>()
            .and_then(|core| {
                core.settings
                    .read()
                    .ok()
                    .map(|settings| !settings.onboarding_completed)
            })
            .unwrap_or(false)
        {
            let _ = window.set_min_size(Some(tauri::LogicalSize::new(540.0, 600.0)));
            let _ = window.unmaximize();
            let _ = window.set_size(tauri::LogicalSize::new(604.0, 820.0));
            let _ = window.center();
        }
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}
pub fn install(app: &tauri::AppHandle, sink: EventSink) {
    use tauri_plugin_deep_link::DeepLinkExt;
    let handle = app.clone();
    let router = Router::new(sink, Arc::new(move || show_main(&handle)));
    app.manage(router.clone());
    let incoming = router.clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            incoming.receive(url.as_str());
        }
    });
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        for url in urls {
            router.receive(url.as_str());
        }
    }
    for arg in std::env::args().filter(|arg| arg.starts_with("opennavo:")) {
        router.receive(&arg);
    }
}
