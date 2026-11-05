use crate::presets::Preset;
use std::{mem::size_of, thread::sleep, time::Duration};
use windows::{
    core::BSTR,
    Win32::{
        Foundation::{HWND, POINT, RECT},
        System::{Com::*, Variant::VARIANT},
        UI::{Accessibility::*, Input::KeyboardAndMouse::*, WindowsAndMessaging::*},
    },
};

struct ComApartment;
impl Drop for ComApartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

pub fn reveal(window: isize, preset: &Preset) -> Result<(), String> {
    unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok() }
        .map_err(|error| format!("Could not initialize Windows accessibility: {error}"))?;
    let _apartment = ComApartment;
    let automation: IUIAutomation =
        unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }
            .map_err(|error| format!("Could not open Windows accessibility: {error}"))?;

    // Capture the cursor position before any interaction so it never moves
    let mut orig_cursor = POINT { x: 0, y: 0 };
    let has_orig = unsafe { GetCursorPos(&mut orig_cursor).is_ok() };
    let orig = has_orig.then_some(orig_cursor);

    let hwnd = ensure_foreground(HWND(window as _))?;
    let root = unsafe { automation.ElementFromHandle(hwnd) }
        .map_err(|_| "Open Helm from the Premiere editor.")?;

    let mut effects = named(&automation, &root, "Effects", UIA_PaneControlTypeId);
    if effects.is_none() {
        let tab = named(&automation, &root, "Effects", UIA_TabItemControlTypeId)
            .and_then(|element| bounds(&element))
            .ok_or("Open Window → Effects in Premiere, then try again.")?;
        click(hwnd, center(tab), orig)?;
        sleep(Duration::from_millis(150));
        effects = named(&automation, &root, "Effects", UIA_PaneControlTypeId);
    }
    let effects = effects.ok_or("Open Window → Effects in Premiere, then try again.")?;
    let search_elem = named(&automation, &effects, "Search", UIA_EditControlTypeId);
    let search = search_elem
        .as_ref()
        .and_then(|element| bounds(element))
        .ok_or(
            "Could not find the Effects search field. Make sure the Effects panel is visible.",
        )?;

    if let Some(ref elem) = search_elem {
        let _ = unsafe { elem.SetFocus() };
    }

    click(hwnd, center(search), orig)?;
    sleep(Duration::from_millis(50));
    ensure_foreground(hwnd)?;
    type_search(&preset.name)?;

    if let Some(orig) = orig {
        let _ = move_cursor(orig);
    }

    Ok(())
}

fn named(
    automation: &IUIAutomation,
    parent: &IUIAutomationElement,
    name: &str,
    control_type: UIA_CONTROLTYPE_ID,
) -> Option<IUIAutomationElement> {
    unsafe {
        let name = automation
            .CreatePropertyCondition(UIA_NamePropertyId, &VARIANT::from(BSTR::from(name)))
            .ok()?;
        let kind = automation
            .CreatePropertyCondition(UIA_ControlTypePropertyId, &VARIANT::from(control_type.0))
            .ok()?;
        let condition = automation.CreateAndCondition(&name, &kind).ok()?;
        parent.FindFirst(TreeScope_Descendants, &condition).ok()
    }
}

fn bounds(element: &IUIAutomationElement) -> Option<RECT> {
    let rect = unsafe { element.CurrentBoundingRectangle().ok()? };
    (rect.left < rect.right && rect.top < rect.bottom).then_some(rect)
}

fn center(rect: RECT) -> POINT {
    POINT {
        x: (rect.left + rect.right) / 2,
        y: (rect.top + rect.bottom) / 2,
    }
}

fn belongs_to(window: HWND, point: POINT) -> bool {
    unsafe {
        GetAncestor(WindowFromPoint(point), GA_ROOTOWNER) == GetAncestor(window, GA_ROOTOWNER)
    }
}

#[link(name = "user32")]
extern "system" {
    fn AttachThreadInput(id_attach: u32, id_attach_to: u32, f_attach: i32) -> i32;
}

fn ensure_foreground(window: HWND) -> Result<HWND, String> {
    let target = if !window.0.is_null() && unsafe { IsWindow(Some(window)).as_bool() } {
        unsafe { GetAncestor(window, GA_ROOTOWNER) }
    } else if let Some(h) = crate::platform::foreground_premiere().or_else(crate::platform::find_premiere_window) {
        unsafe { GetAncestor(HWND(h as _), GA_ROOTOWNER) }
    } else {
        return Err("Open Helm from the Premiere editor.".into());
    };

    unsafe {
        let fg = GetForegroundWindow();
        let fg_owner = if !fg.0.is_null() {
            GetAncestor(fg, GA_ROOTOWNER)
        } else {
            fg
        };
        if fg_owner == target {
            return Ok(target);
        }

        let mut fg_thread = 0;
        if !fg.0.is_null() {
            GetWindowThreadProcessId(fg, Some(&mut fg_thread));
        }
        let cur_thread = windows_sys::Win32::System::Threading::GetCurrentThreadId();
        let mut target_thread = 0;
        GetWindowThreadProcessId(target, Some(&mut target_thread));

        if fg_thread != 0 && fg_thread != target_thread {
            let _ = AttachThreadInput(cur_thread, fg_thread, 1);
            let _ = AttachThreadInput(fg_thread, target_thread, 1);
        }

        let _ = BringWindowToTop(target);
        let _ = SetForegroundWindow(target);

        if fg_thread != 0 && fg_thread != target_thread {
            let _ = AttachThreadInput(fg_thread, target_thread, 0);
            let _ = AttachThreadInput(cur_thread, fg_thread, 0);
        }

        for _ in 0..20 {
            let cur_fg = GetForegroundWindow();
            if !cur_fg.0.is_null() && GetAncestor(cur_fg, GA_ROOTOWNER) == target {
                return Ok(target);
            }
            sleep(Duration::from_millis(15));
        }
    }
    Ok(target)
}

fn click(window: HWND, point: POINT, orig_cursor: Option<POINT>) -> Result<(), String> {
    ensure_foreground(window)?;
    if !belongs_to(window, point) {
        return Err("Another window covers the Premiere Effects panel.".into());
    }
    move_cursor(point)?;
    inject(&[mouse(MOUSEEVENTF_LEFTDOWN), mouse(MOUSEEVENTF_LEFTUP)])?;
    if let Some(orig) = orig_cursor {
        let _ = move_cursor(orig);
    }
    Ok(())
}

fn type_search(name: &str) -> Result<(), String> {
    let mut input = vec![
        key(VK_CONTROL, 0, KEYBD_EVENT_FLAGS(0)),
        key(VK_A, 0, KEYBD_EVENT_FLAGS(0)),
        key(VK_A, 0, KEYEVENTF_KEYUP),
        key(VK_CONTROL, 0, KEYEVENTF_KEYUP),
    ];
    for unit in name.encode_utf16() {
        input.push(key(VIRTUAL_KEY(0), unit, KEYEVENTF_UNICODE));
        input.push(key(
            VIRTUAL_KEY(0),
            unit,
            KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
        ));
    }
    inject(&input)
}

fn key(vk: VIRTUAL_KEY, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: scan,
                dwFlags: flags,
                ..Default::default()
            },
        },
    }
}

fn mouse(flags: MOUSE_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dwFlags: flags,
                ..Default::default()
            },
        },
    }
}

fn inject(input: &[INPUT]) -> Result<(), String> {
    if unsafe { SendInput(input, size_of::<INPUT>() as i32) } as usize == input.len() {
        Ok(())
    } else {
        Err(
            "Windows blocked input to Premiere. Run Helm and Premiere at the same privilege level."
                .into(),
        )
    }
}

fn move_cursor(point: POINT) -> Result<(), String> {
    unsafe { SetCursorPos(point.x, point.y) }.map_err(|_| "Could not move the pointer.".into())
}
