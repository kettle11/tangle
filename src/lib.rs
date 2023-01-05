use core::cell::RefCell;

thread_local! {
    /// Data sent from the host.
    /// Unique to this Wasm thread.
    pub static DATA_FROM_HOST: RefCell<Vec<u8>> = RefCell::new(Vec::new());
}

/// Called by the host to reserve scratch space to pass data into kwasm.
/// returns a pointer to the allocated data.
#[no_mangle]
pub extern "C" fn reserve_space(space: usize) -> *mut u8 {
    DATA_FROM_HOST.with(|d| {
        let mut d = d.borrow_mut();
        d.clear();
        d.resize(space, 0);
        d.as_mut_ptr()
    })
}

#[no_mangle]
pub extern "C" fn prepare_wasm() {
    setup_panic_hook();
    DATA_FROM_HOST.with(|d| {
        let mut d = d.borrow_mut();

        let output = wasm_guardian::transform_wasm_to_track_changes(&d);
        *d = output;
    })
}

#[no_mangle]
pub extern "C" fn get_output_ptr() -> *mut u8 {
    setup_panic_hook();
    DATA_FROM_HOST.with(|d| {
        let mut d = d.borrow_mut();
        d.as_mut_ptr()
    })
}

#[no_mangle]
pub extern "C" fn get_output_len() -> usize {
    setup_panic_hook();
    DATA_FROM_HOST.with(|d| {
        let d = d.borrow();
        d.len()
    })
}

extern "C" {
    pub(crate) fn external_log(data: *const u8, data_length: u32);
    pub(crate) fn external_error(data: *const u8, data_length: u32);
}

pub fn log(s: &str) {
    unsafe {
        external_log(s.as_ptr(), s.len() as _);
    }
}

pub fn error(s: &str) {
    unsafe {
        external_error(s.as_ptr(), s.len() as _);
    }
}

fn hook_impl(info: &std::panic::PanicInfo) {
    let message = info.to_string();
    error(&message);
}

/// Sets up a panic hook to print a slightly more useful error-message to the console.
pub fn setup_panic_hook() {
    use std::sync::Once;
    static SET_HOOK: Once = Once::new();
    SET_HOOK.call_once(|| {
        std::panic::set_hook(Box::new(hook_impl));
    });
}

static mut GLOBAL: u32 = 2;

#[no_mangle]
pub extern "C" fn test_message() -> u32 {
    // log(&"HELLO FROM RUST".to_string());
    unsafe {
        GLOBAL += 3;
        GLOBAL
        //&GLOBAL as *const _ as _
    }
}
