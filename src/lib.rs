use core::cell::RefCell;
use std::io::Write;

thread_local! {
    /// Data sent from the host.
    /// Unique to this Wasm thread.
    pub static DATA_FROM_HOST: RefCell<Vec<u8>> = RefCell::new(Vec::new());
    pub static DATA_SWAP: RefCell<Vec<u8>> = RefCell::new(Vec::new());

}

/// Called by the host to reserve scratch space to pass data into kwasm.
/// returns a pointer to the allocated data.
#[no_mangle]
pub extern "C" fn reserve_space(space: usize) -> *mut u8 {
    DATA_FROM_HOST.with(|d| {
        let mut d = d.borrow_mut();
        d.clear();
        d.reserve(space);

        // This is obviously unsafe, but zeroing the memory was taking a few milliseconds
        // for large values.
        unsafe {
            d.set_len(space);
        }
        //d.resize(space, 0);
        d.as_mut_ptr()
    })
}

#[no_mangle]
pub extern "C" fn prepare_wasm() {
    setup_panic_hook();
    DATA_FROM_HOST.with(|d| {
        let mut d = d.borrow_mut();

        let output = wasm_guardian::transform_wasm_to_track_changes(&d, true, true);
        *d = output;
    })
}

#[no_mangle]
pub extern "C" fn prepare_wasm_export_globals_only() {
    setup_panic_hook();
    DATA_FROM_HOST.with(|d| {
        let mut d = d.borrow_mut();

        let output = wasm_guardian::transform_wasm_to_track_changes(&d, true, false);
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

// Hashes data in DATA_FROM_HOST and returns it in DATA_FROM_HOST
#[no_mangle]
pub extern "C" fn xxh3_128_bit_hash() {
    DATA_FROM_HOST.with(|d| {
        let mut d = d.borrow_mut();
        let result = xxhash_rust::xxh3::xxh3_128(&d);
        d.clear();
        d.write(&result.to_be_bytes()).unwrap();
    })
}

/// Write data with reserve_space and then returns the new data location as a pointer and length written
/// to data.
#[no_mangle]
pub extern "C" fn gzip_encode() {
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), Default::default());

    DATA_FROM_HOST.with(|d| {
        let mut input = d.borrow_mut();
        let input: &mut Vec<u8> = &mut input;
        encoder.write_all(&input).unwrap();
        let result = encoder.finish().unwrap();

        input.clear();
        input
            .write(&(result.as_ptr() as u32).to_le_bytes())
            .unwrap();
        input.write(&(result.len() as u32).to_le_bytes()).unwrap();

        DATA_SWAP.with(|d| {
            d.replace(result);
        });
    });
}

#[no_mangle]
pub extern "C" fn gzip_decode() {
    use std::io::Read;
    DATA_FROM_HOST.with(|d| {
        let mut input = d.borrow_mut();

        DATA_SWAP.with(|d| {
            let mut d = d.borrow_mut();

            {
                let mut decoder = flate2::read::GzDecoder::new(input.as_slice());
                d.clear();
                decoder.read_to_end(&mut d).unwrap();
            }

            input.clear();
            input.write(&(d.as_ptr() as u32).to_le_bytes()).unwrap();
            input.write(&(d.len() as u32).to_le_bytes()).unwrap();
        });
    });
}

/*
#[test]
fn test_compression() {
    /
    let mut output = Vec::new();

    {
        let bytes = include_bytes!("../web_example/example_script.wasm");

        encoder.write_all(&bytes).unwrap();
        let result = encoder.finish().unwrap();
        result.len()
    }
}
*/
