thread_local! {
    /// Data sent from the host.
    pub static DATA_FROM_HOST: RefCell<Vec<u8>> = RefCell::new(Vec::new());
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
pub extern "C" fn data_len(space: usize) -> u32 {
    DATA_FROM_HOST.with(|d| {
        let mut d = d.borrow_mut();
        d.len()
    })
}

#[no_mangle]
pub extern "C" fn data_ptr(space: usize) -> *const u8 {
    DATA_FROM_HOST.with(|d| {
        let mut d = d.borrow_mut();
        d.ptr()
    })
}
