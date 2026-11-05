#[cfg(windows)]
pub fn foreground_premiere() -> Option<isize> {
    use windows_sys::Win32::{System::Threading::*, UI::WindowsAndMessaging::*};
    unsafe {
        let window = GetForegroundWindow();
        if window.is_null() {
            return None;
        }
        let mut pid = 0;
        GetWindowThreadProcessId(window, &mut pid);
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return None;
        }
        let mut path = [0u16; 1024];
        let mut length = path.len() as u32;
        let success = QueryFullProcessImageNameW(process, 0, path.as_mut_ptr(), &mut length);
        windows_sys::Win32::Foundation::CloseHandle(process);
        let path = String::from_utf16_lossy(&path[..length as usize]).to_ascii_lowercase();
        (success != 0 && path.ends_with("\\adobe premiere pro.exe")).then_some(window as isize)
    }
}

#[cfg(windows)]
pub fn find_premiere_window() -> Option<isize> {
    use windows_sys::Win32::{
        Foundation::{HWND, LPARAM},
        System::Threading::*,
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
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return 1;
        }
        let mut path = [0u16; 1024];
        let mut length = path.len() as u32;
        let success = QueryFullProcessImageNameW(process, 0, path.as_mut_ptr(), &mut length);
        windows_sys::Win32::Foundation::CloseHandle(process);
        if success != 0 {
            let path_str = String::from_utf16_lossy(&path[..length as usize]).to_ascii_lowercase();
            if path_str.ends_with("\\adobe premiere pro.exe") {
                state.found = Some(hwnd);
                return 0;
            }
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
