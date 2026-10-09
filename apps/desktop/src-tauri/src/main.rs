// Suppress terminal windows in release builds (Windows only; retained from the template).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    opennavo_desktop_lib::run();
}
