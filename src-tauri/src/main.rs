//! Toolblox executable entry point.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    toolblox_lib::run()
}
