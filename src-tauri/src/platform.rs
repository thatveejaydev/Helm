#[cfg(windows)]
fn is_premiere_pid(pid: u32, check_alive: bool) -> bool {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, WAIT_TIMEOUT},
        System::Threading::*,
    };
    if pid == 0 {
        return false;
    }
    unsafe {
        let access = PROCESS_QUERY_LIMITED_INFORMATION
            | if check_alive { PROCESS_SYNCHRONIZE } else { 0 };
        let process = OpenProcess(access, 0, pid);
        if process.is_null() {
            return false;
        }
        let alive = !check_alive || WaitForSingleObject(process, 0) == WAIT_TIMEOUT;
        let mut path = [0u16; 1024];
        let mut length = path.len() as u32;
        let success =
            alive && QueryFullProcessImageNameW(process, 0, path.as_mut_ptr(), &mut length) != 0;
        CloseHandle(process);
        if !success {
            return false;
        }
        String::from_utf16_lossy(&path[..length as usize])
            .to_ascii_lowercase()
            .ends_with("\\adobe premiere pro.exe")
    }
}

#[cfg(windows)]
pub fn is_premiere_process_alive(pid: u32) -> bool {
    is_premiere_pid(pid, true)
}

#[cfg(windows)]
pub fn premiere_pids() -> std::collections::HashSet<u32> {
    use std::collections::HashSet;
    use windows_sys::Win32::{
        Foundation::{HWND, LPARAM},
        UI::WindowsAndMessaging::*,
    };

    struct PidScan {
        checked: HashSet<u32>,
        found: HashSet<u32>,
    }

    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> i32 {
        let state = &mut *(lparam as *mut PidScan);
        if IsWindowVisible(hwnd) == 0 {
            return 1;
        }
        let mut pid = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid != 0 && state.checked.insert(pid) && is_premiere_pid(pid, true) {
            state.found.insert(pid);
        }
        1
    }

    let mut state = PidScan {
        checked: HashSet::new(),
        found: HashSet::new(),
    };
    unsafe {
        EnumWindows(Some(enum_proc), &mut state as *mut _ as LPARAM);
    }
    state.found
}

#[cfg(windows)]
pub fn foreground_premiere() -> Option<isize> {
    use windows_sys::Win32::UI::WindowsAndMessaging::*;
    unsafe {
        let window = GetForegroundWindow();
        if window.is_null() {
            return None;
        }
        let mut pid = 0;
        GetWindowThreadProcessId(window, &mut pid);
        is_premiere_pid(pid, false).then_some(window as isize)
    }
}

#[cfg(windows)]
pub fn find_premiere_window() -> Option<isize> {
    use windows_sys::Win32::{
        Foundation::{HWND, LPARAM},
        UI::WindowsAndMessaging::*,
    };

    struct SearchState {
        found: Option<HWND>,
    }

    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> i32 {
        let state = &mut *(lparam as *mut SearchState);
        if IsWindowVisible(hwnd) == 0 {
            return 1;
        }
        let mut pid = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if is_premiere_pid(pid, false) {
            state.found = Some(hwnd);
            return 0;
        }
        1
    }

    let mut state = SearchState { found: None };
    unsafe {
        EnumWindows(Some(enum_proc), &mut state as *mut _ as LPARAM);
    }
    state.found.map(|h| h as isize)
}

#[cfg(windows)]
pub fn window_center(handle: isize) -> Option<(i32, i32)> {
    use windows_sys::Win32::{Foundation::RECT, UI::WindowsAndMessaging::GetWindowRect};
    let mut rect = RECT::default();
    unsafe {
        (GetWindowRect(handle as _, &mut rect) != 0)
            .then_some(((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2))
    }
}

#[cfg(windows)]
pub fn restore_focus(handle: isize) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{IsWindow, SetForegroundWindow};
    unsafe {
        if handle != 0 && IsWindow(handle as _) != 0 {
            SetForegroundWindow(handle as _);
        }
    }
}

#[cfg(windows)]
pub fn style_window(hwnd: isize) {
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_COLOR_NONE, DWMWA_USE_IMMERSIVE_DARK_MODE,
        DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DONOTROUND,
    };
    unsafe {
        let dark_mode: i32 = 1;
        let _ = DwmSetWindowAttribute(
            hwnd as _,
            DWMWA_USE_IMMERSIVE_DARK_MODE as _,
            &dark_mode as *const _ as _,
            std::mem::size_of::<i32>() as u32,
        );
        let color_none = DWMWA_COLOR_NONE;
        let _ = DwmSetWindowAttribute(
            hwnd as _,
            DWMWA_BORDER_COLOR as _,
            &color_none as *const _ as _,
            std::mem::size_of::<u32>() as u32,
        );
        let corner_preference = DWMWCP_DONOTROUND;
        let _ = DwmSetWindowAttribute(
            hwnd as _,
            DWMWA_WINDOW_CORNER_PREFERENCE as _,
            &corner_preference as *const _ as _,
            std::mem::size_of::<i32>() as u32,
        );
    }
}

// The bridge and UI are portable. macOS foreground integration is a separate milestone.
#[cfg(not(windows))]
pub fn is_premiere_process_alive(_: u32) -> bool {
    false
}
#[cfg(not(windows))]
pub fn premiere_pids() -> std::collections::HashSet<u32> {
    std::collections::HashSet::new()
}
#[cfg(not(windows))]
pub fn foreground_premiere() -> Option<isize> {
    Some(0)
}
#[cfg(not(windows))]
pub fn find_premiere_window() -> Option<isize> {
    None
}
#[cfg(not(windows))]
pub fn window_center(_: isize) -> Option<(i32, i32)> {
    None
}
#[cfg(not(windows))]
pub fn restore_focus(_: isize) {}
#[cfg(not(windows))]
pub fn style_window(_: isize) {}
