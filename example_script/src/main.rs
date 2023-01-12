fn main() {}

#[derive(Copy, Clone)]
struct Color {
    r: u8,
    g: u8,
    b: u8,
    a: u8,
}

#[derive(Copy, Clone)]
struct Rectangle {
    x: u32,
    y: u32,
    w: u32,
    h: u32,
}

struct WorldState {
    rects: Vec<(Color, Rectangle)>,
}

static mut STATE: WorldState = WorldState { rects: Vec::new() };

#[no_mangle]
extern "C" fn step() {
    unsafe {
        let offset = (STATE.rects.len() * 10) as u32;

        STATE.rects.push((
            Color {
                r: 255,
                g: 0,
                b: 100,
                a: 255,
            },
            Rectangle {
                x: offset,
                y: offset,
                w: 100,
                h: 100,
            },
        ));
    }
}

#[no_mangle]
extern "C" fn fixed_update(time: u32) {
    unsafe {
        // let offset = (STATE.rects.len() * 10) as u32;

        let time_frame = 6000; // 6 seconds
        let t = (time % time_frame) as f32;
        STATE.rects.clear();
        STATE.rects.push((
            Color {
                r: (((t / time_frame as f32 * 3.14 * 2.0).sin() + 1.0) / 2.0 * 255.0) as u8,
                g: 0,
                b: 0,
                a: 255,
            },
            Rectangle {
                x: 100,
                y: 100,
                w: 100,
                h: 100,
            },
        ));
    }
}

#[no_mangle]
extern "C" fn draw() {
    unsafe {
        for (Color { r, g, b, a }, Rectangle { x, y, w, h }) in STATE.rects.iter().copied() {
            draw_rect(r, g, b, a, x, y, w, h);
        }
    }
}

extern "C" {
    pub(crate) fn draw_rect(r: u8, g: u8, b: u8, a: u8, x: u32, y: u32, w: u32, h: u32);
}
