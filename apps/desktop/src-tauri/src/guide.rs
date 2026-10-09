//! Permission overlay (06 §12.7): after opening System Settings, show a small overlay beneath its window,
//! with a draggable OpenNavo icon and instructions; poll permissions, then show completion and close automatically.
use crate::{AppError, core::DesktopCore, events::PermissionsChanged, model::*};
use std::{
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tauri::{LogicalPosition, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_specta::Event;

pub const LABEL: &str = "permission-guide";
/// Window size includes 12 px transparent margins around the 336×88 panel; frontend draws corners/shadows.
pub const WIDTH: f64 = 360.;
pub const HEIGHT: f64 = 112.;
const POLL: Duration = Duration::from_millis(250);
/// Check permissions every two iterations (about 0.5 seconds).
const STATUS_EVERY: u32 = 2;
/// Delay before closing after showing Enabled.
const DONE_DELAY: Duration = Duration::from_millis(1600);
/// Treat System Settings as closed if its window is absent longer than this.
const SETTINGS_GONE: Duration = Duration::from_millis(1500);
/// Show at screen bottom if System Settings cannot be found.
const FALLBACK_AFTER: Duration = Duration::from_millis(1500);
const MAX_LIFETIME: Duration = Duration::from_secs(600);

/// Increment generation on every open/close; old polling threads exit when the generation changes.
#[derive(Default)]
pub struct Guide {
    generation: AtomicU64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Frame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Frame {
    fn contains_center_of(&self, other: Frame) -> bool {
        let (x, y) = (other.x + other.width / 2., other.y + other.height / 2.);
        x >= self.x && x < self.x + self.width && y >= self.y && y < self.y + self.height
    }
}

fn slug(pane: PrivacyPane) -> Result<&'static str, AppError> {
    match pane {
        PrivacyPane::AppManagement => Ok("app_management"),
        PrivacyPane::FullDiskAccess => Ok("full_disk_access"),
        PrivacyPane::Notifications => Err(AppError::new("E_INVALID_ARG", "guide_pane")),
    }
}

pub fn granted(pane: PrivacyPane, permissions: &Permissions) -> bool {
    match pane {
        PrivacyPane::AppManagement => permissions.app_management == PermissionState::Granted,
        PrivacyPane::FullDiskAccess => permissions.full_disk_access == PermissionState::Granted,
        PrivacyPane::Notifications => false,
    }
}

/// Center below System Settings' content area (right of sidebar); if insufficient space, align inside its bottom edge, staying within usable screen bounds.
pub fn anchor(settings: Frame, screen: Frame) -> (f64, f64) {
    const GAP: f64 = 2.;
    const INSET: f64 = 8.;
    let sidebar = (settings.width * 0.3).clamp(180., 260.);
    let column_width = (settings.width - sidebar).max(0.);
    let x = settings.x + sidebar + (column_width - WIDTH) / 2.;
    let below = settings.y + settings.height + GAP;
    let y = if below + HEIGHT <= screen.y + screen.height {
        below
    } else {
        settings.y + settings.height - HEIGHT - INSET
    };
    let max_x = (screen.x + screen.width - WIDTH).max(screen.x);
    let max_y = (screen.y + screen.height - HEIGHT).max(screen.y);
    (x.clamp(screen.x, max_x), y.clamp(screen.y, max_y))
}

/// Center at screen bottom if System Settings cannot be found.
pub fn fallback(screen: Frame) -> (f64, f64) {
    (
        screen.x + (screen.width - WIDTH) / 2.,
        (screen.y + screen.height - HEIGHT - 72.).max(screen.y),
    )
}

/// Running .app bundle; development builds are not draggable .app bundles.
pub fn bundle_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    exe.ancestors()
        .find(|path| path.extension().is_some_and(|extension| extension == "app"))
        .map(Path::to_path_buf)
}

fn error(error: impl std::fmt::Display) -> AppError {
    AppError::new("E_UNKNOWN", "permission_guide").with_detail(error.to_string())
}

pub async fn open(app: &tauri::AppHandle, pane: PrivacyPane) -> Result<(), AppError> {
    let slug = slug(pane)?;
    crate::system::open(&[crate::system::privacy_url(pane, &app.config().identifier)?]).await?;
    let generation = app
        .state::<Arc<Guide>>()
        .generation
        .fetch_add(1, Ordering::AcqRel)
        + 1;
    match app.get_webview_window(LABEL) {
        // If already open, change only content; the new polling thread continues positioning.
        Some(window) => window
            .eval(format!("location.hash = '#/permission-guide/{slug}'"))
            .map_err(error)?,
        None => {
            WebviewWindowBuilder::new(
                app,
                LABEL,
                WebviewUrl::App(format!("index.html#/permission-guide/{slug}").into()),
            )
            .title("OpenNavo")
            .inner_size(WIDTH, HEIGHT)
            .decorations(false)
            .transparent(true)
            // Frontend draws corners/shadows; native shadows would expose rectangular transparent window bounds.
            .shadow(false)
            .always_on_top(true)
            .visible_on_all_workspaces(true)
            .visible(false)
            .resizable(false)
            .skip_taskbar(true)
            // Do not steal focus from System Settings; the first click should begin dragging the icon.
            .focused(false)
            .focusable(false)
            .accept_first_mouse(true)
            .build()
            .map_err(error)?;
        }
    }
    watch(app.clone(), pane, generation);
    Ok(())
}

pub fn close(app: &tauri::AppHandle) {
    if let Some(guide) = app.try_state::<Arc<Guide>>() {
        guide.generation.fetch_add(1, Ordering::AcqRel);
    }
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.close();
    }
}

fn screens(app: &tauri::AppHandle) -> Vec<Frame> {
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|monitor| {
            let scale = monitor.scale_factor();
            let area = monitor.work_area();
            Frame {
                x: f64::from(area.position.x) / scale,
                y: f64::from(area.position.y) / scale,
                width: f64::from(area.size.width) / scale,
                height: f64::from(area.size.height) / scale,
            }
        })
        .collect()
}

/// Polling: follow System Settings, push permission changes, close shortly after authorization or when Settings closes/times out.
fn watch(app: tauri::AppHandle, pane: PrivacyPane, generation: u64) {
    std::thread::spawn(move || {
        let started = Instant::now();
        let mut tick: u32 = 0;
        let mut last: Option<Permissions> = None;
        let mut position: Option<(f64, f64)> = None;
        let mut shown = false;
        let mut seen_settings = false;
        let mut settings_missing: Option<Instant> = None;
        let mut done_at: Option<Instant> = None;
        loop {
            let current = app
                .try_state::<Arc<Guide>>()
                .map(|guide| guide.generation.load(Ordering::Acquire));
            if current != Some(generation) {
                break;
            }
            let Some(window) = app.get_webview_window(LABEL) else {
                break;
            };
            let now = Instant::now();
            let next = match settings_frame() {
                Some(frame) => {
                    seen_settings = true;
                    settings_missing = None;
                    let screens = screens(&app);
                    screens
                        .iter()
                        .find(|screen| screen.contains_center_of(frame))
                        .or(screens.first())
                        .map(|screen| anchor(frame, *screen))
                }
                None if seen_settings => {
                    if now.duration_since(*settings_missing.get_or_insert(now)) > SETTINGS_GONE {
                        close(&app);
                        break;
                    }
                    None
                }
                None if !shown && now.duration_since(started) > FALLBACK_AFTER => {
                    screens(&app).first().map(|screen| fallback(*screen))
                }
                None => None,
            };
            if let Some(next) = next
                && position != Some(next)
            {
                let _ = window.set_position(LogicalPosition::new(next.0, next.1));
                position = Some(next);
            }
            if position.is_some() && !shown {
                let _ = window.show();
                shown = true;
            }
            if tick.is_multiple_of(STATUS_EVERY)
                && let Some(core) = app.try_state::<Arc<DesktopCore>>()
                && let Ok(status) = core.permissions_blocking()
            {
                if last != Some(status) {
                    let _ = PermissionsChanged(status).emit(&app);
                    last = Some(status);
                }
                if granted(pane, &status) && done_at.is_none() {
                    done_at = Some(now);
                }
            }
            if done_at.is_some_and(|at| now.duration_since(at) > DONE_DELAY)
                || now.duration_since(started) > MAX_LIFETIME
            {
                close(&app);
                break;
            }
            tick = tick.wrapping_add(1);
            std::thread::sleep(POLL);
        }
    });
}

#[cfg(target_os = "macos")]
fn settings_frame() -> Option<Frame> {
    use objc2::{rc::Retained, runtime::AnyObject};
    use objc2_foundation::{NSArray, NSDictionary, NSNumber, NSString};
    use std::collections::HashMap;

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGWindowListCopyWindowInfo(
            option: u32,
            relative_to_window: u32,
        ) -> *mut NSArray<NSDictionary<NSString, AnyObject>>;
    }
    const ON_SCREEN_ONLY: u32 = 1;
    const EXCLUDE_DESKTOP_ELEMENTS: u32 = 1 << 4;

    // SAFETY: Copy returns a +1 array, toll-free bridged with NSArray; Retained releases it.
    let windows = unsafe {
        Retained::from_raw(CGWindowListCopyWindowInfo(
            ON_SCREEN_ONLY | EXCLUDE_DESKTOP_ELEMENTS,
            0,
        ))
    }?;
    let number = |info: &NSDictionary<NSString, AnyObject>, key: &str| {
        info.objectForKey(&NSString::from_str(key))
            .and_then(|value| value.downcast::<NSNumber>().ok())
    };
    let mut owners: HashMap<i32, bool> = HashMap::new();
    // Windows are ordered front to back; the first match is the foremost System Settings window.
    for info in windows.iter() {
        if number(&info, "kCGWindowLayer").map(|layer| layer.integerValue()) != Some(0) {
            continue;
        }
        let Some(pid) = number(&info, "kCGWindowOwnerPID").map(|pid| pid.intValue()) else {
            continue;
        };
        if !*owners.entry(pid).or_insert_with(|| is_system_settings(pid)) {
            continue;
        }
        let bounds = info
            .objectForKey(&NSString::from_str("kCGWindowBounds"))?
            .downcast::<NSDictionary>()
            .ok()?;
        let value = |key: &str| {
            let key = NSString::from_str(key);
            bounds
                .objectForKey(&key)
                .and_then(|value| value.downcast::<NSNumber>().ok())
                .map(|value| value.doubleValue())
        };
        let frame = Frame {
            x: value("X")?,
            y: value("Y")?,
            width: value("Width")?,
            height: value("Height")?,
        };
        // Skip small windows such as tooltips and menus.
        if frame.width >= 320. && frame.height >= 240. {
            return Some(frame);
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn is_system_settings(pid: i32) -> bool {
    unsafe extern "C" {
        fn proc_pidpath(pid: i32, buffer: *mut std::ffi::c_void, size: u32) -> i32;
    }
    let mut buffer = [0u8; 4096];
    // SAFETY: buffer size is PROC_PIDPATHINFO_MAXSIZE; read only the returned length.
    let length = unsafe { proc_pidpath(pid, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
    usize::try_from(length)
        .ok()
        .filter(|length| *length > 0)
        .and_then(|length| std::str::from_utf8(&buffer[..length]).ok())
        .is_some_and(|path| {
            path.ends_with("/System Settings.app/Contents/MacOS/System Settings")
                || path.ends_with("/System Preferences.app/Contents/MacOS/System Preferences")
        })
}

#[cfg(not(target_os = "macos"))]
fn settings_frame() -> Option<Frame> {
    None
}

/// Drag OpenNavo.app from the overlay into System Settings privacy lists; call on the main thread while the mouse is down.
#[cfg(target_os = "macos")]
pub fn drag(window: &tauri::WebviewWindow) -> Result<(), AppError> {
    native::begin(window)
}

#[cfg(not(target_os = "macos"))]
pub fn drag(_window: &tauri::WebviewWindow) -> Result<(), AppError> {
    Err(AppError::new("E_INVALID_ARG", "guide_drag_platform"))
}

#[cfg(target_os = "macos")]
mod native {
    use super::*;
    use objc2::{
        AnyThread, MainThreadMarker, MainThreadOnly, define_class, msg_send,
        rc::Retained,
        runtime::{AnyObject, ProtocolObject},
    };
    use objc2_app_kit::{
        NSApplication, NSDragOperation, NSDraggingContext, NSDraggingItem, NSDraggingSession,
        NSDraggingSource, NSEventType, NSView, NSWorkspace,
    };
    use objc2_foundation::{
        NSArray, NSObject, NSObjectProtocol, NSPoint, NSRect, NSSize, NSString, NSURL,
    };

    define_class!(
        // SAFETY: NSObject imposes no subclassing requirements; DragSource does not implement Drop.
        #[unsafe(super = NSObject)]
        #[thread_kind = MainThreadOnly]
        #[name = "OpenNavoPermissionDragSource"]
        struct DragSource;

        // SAFETY: NSObjectProtocol imposes no additional requirements.
        unsafe impl NSObjectProtocol for DragSource {}

        // SAFETY: method signature matches NSDraggingSource.
        unsafe impl NSDraggingSource for DragSource {
            #[unsafe(method(draggingSession:sourceOperationMaskForDraggingContext:))]
            fn source_operation_mask(
                &self,
                _session: &NSDraggingSession,
                _context: NSDraggingContext,
            ) -> NSDragOperation {
                // Do not offer move/delete: dragging to Trash or folders must not move OpenNavo itself.
                NSDragOperation::Copy | NSDragOperation::Link | NSDragOperation::Generic
            }
        }
    );

    impl DragSource {
        fn new(mtm: MainThreadMarker) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(());
            // SAFETY: NSObject init takes no arguments.
            unsafe { msg_send![super(this), init] }
        }
    }

    thread_local! {
        // The drag source must survive the session; one per process suffices.
        static SOURCE: std::cell::OnceCell<Retained<DragSource>> = const { std::cell::OnceCell::new() };
    }

    pub fn begin(window: &tauri::WebviewWindow) -> Result<(), AppError> {
        let fail = |reason: &str| AppError::new("E_UNKNOWN", reason);
        let mtm = MainThreadMarker::new().ok_or_else(|| fail("guide_drag_thread"))?;
        let bundle = super::bundle_path().ok_or_else(|| fail("guide_drag_bundle"))?;
        let event = NSApplication::sharedApplication(mtm)
            .currentEvent()
            .ok_or_else(|| fail("guide_drag_event"))?;
        let kind = event.r#type();
        // Start only during mouse-down/drag events, otherwise AppKit throws.
        if kind != NSEventType::LeftMouseDown && kind != NSEventType::LeftMouseDragged {
            return Err(fail("guide_drag_event"));
        }
        let pointer = window.ns_view().map_err(super::error)?.cast::<NSView>();
        // SAFETY: Tauri supplies this window's content-view pointer; use on the main thread while the window remains alive throughout the call.
        let view = unsafe { pointer.as_ref() }.ok_or_else(|| fail("guide_drag_view"))?;
        let path = NSString::from_str(&bundle.to_string_lossy());
        let url = NSURL::fileURLWithPath(&path);
        let item = NSDraggingItem::initWithPasteboardWriter(
            NSDraggingItem::alloc(),
            ProtocolObject::from_ref(&*url),
        );
        let icon = NSWorkspace::sharedWorkspace().iconForFile(&path);
        icon.setSize(NSSize::new(64., 64.));
        let location = view.convertPoint_fromView(event.locationInWindow(), None);
        let frame = NSRect::new(
            NSPoint::new(location.x - 32., location.y - 32.),
            NSSize::new(64., 64.),
        );
        let contents: &AnyObject = &icon;
        // SAFETY: contents is NSImage, satisfying dragging-item content requirements.
        unsafe { item.setDraggingFrame_contents(frame, Some(contents)) };
        let source = SOURCE.with(|cell| cell.get_or_init(|| DragSource::new(mtm)).clone());
        let items = NSArray::from_retained_slice(&[item]);
        view.beginDraggingSessionWithItems_event_source(
            &items,
            &event,
            ProtocolObject::from_ref(&*source),
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREEN: Frame = Frame {
        x: 0.,
        y: 25.,
        width: 1512.,
        height: 920.,
    };

    #[test]
    fn anchors_below_the_settings_content_column() {
        let settings = Frame {
            x: 300.,
            y: 120.,
            width: 715.,
            height: 600.,
        };
        let (x, y) = anchor(settings, SCREEN);
        // Sidebar about 215; content center = 300 + 215 + 250 = 765; overlay left = 765 - 180.
        assert!((x - 585.).abs() < 1.);
        assert!((y - 722.).abs() < 1.);
    }

    #[test]
    fn falls_inside_the_window_when_there_is_no_room_below() {
        let settings = Frame {
            x: 300.,
            y: 300.,
            width: 715.,
            height: 640.,
        };
        let (_, y) = anchor(settings, SCREEN);
        assert!((y - (300. + 640. - HEIGHT - 8.)).abs() < 1.);
        assert!(y + HEIGHT <= SCREEN.y + SCREEN.height);
    }

    #[test]
    fn stays_on_screen_and_falls_back_to_the_bottom_center() {
        let settings = Frame {
            x: -200.,
            y: 40.,
            width: 400.,
            height: 300.,
        };
        let (x, _) = anchor(settings, SCREEN);
        assert!(x >= SCREEN.x);
        let (x, y) = fallback(SCREEN);
        assert!((x - (1512. - WIDTH) / 2.).abs() < 1.);
        assert!(y + HEIGHT < SCREEN.y + SCREEN.height);
    }

    /// Exercise real window-list/process-path reads: None with Settings closed; valid bounds when open.
    #[cfg(target_os = "macos")]
    #[test]
    fn reads_the_window_list_without_crashing() {
        if let Some(frame) = settings_frame() {
            assert!(frame.width >= 320. && frame.height >= 240.);
        }
        assert!(!is_system_settings(std::process::id() as i32));
    }

    #[test]
    fn only_privacy_panes_have_a_guide() {
        let permissions = Permissions {
            app_management: PermissionState::Granted,
            full_disk_access: PermissionState::Denied,
            relaunch_required: false,
        };
        assert!(granted(PrivacyPane::AppManagement, &permissions));
        assert!(!granted(PrivacyPane::FullDiskAccess, &permissions));
        assert!(slug(PrivacyPane::Notifications).is_err());
        assert_eq!(
            slug(PrivacyPane::FullDiskAccess).ok(),
            Some("full_disk_access")
        );
    }
}
