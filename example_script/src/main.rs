fn main() {}

#[derive(Copy, Clone)]
struct Color {
    r: u8,
    g: u8,
    b: u8,
    a: u8,
}

struct WorldState {
    players: Vec<Player>,
}

#[derive(Copy, Clone)]
struct Player {
    direction: (u32, u32),
    position: (u32, u32),
    color: Color,
}

#[no_mangle]
extern "C" fn add_player(r: u8, g: u8, b: u8) -> usize {
    unsafe {
        STATE.players.push(Player {
            direction: (0, 0),
            position: (0, 0),
            color: Color { r, g, b, a: 255 },
        });
        STATE.players.len() - 1
    }
}

static mut STATE: WorldState = WorldState {
    players: Vec::new(),
};

const SPEED: u32 = 10;

#[no_mangle]
extern "C" fn set_x_axis(player: usize, state: u32) {
    unsafe {
        STATE.players.get_mut(player).map(|p| p.direction.0 = state);
    }
}

#[no_mangle]
extern "C" fn set_y_axis(player: usize, state: u32) {
    unsafe {
        STATE.players.get_mut(player).map(|p| p.direction.1 = state);
    }
}

#[no_mangle]
extern "C" fn fixed_update(_time: u32) {
    unsafe {
        for player in STATE.players.iter_mut() {
            player.position.0 += player.direction.0 * SPEED;
            player.position.1 += player.direction.1 * SPEED;
        }

        /*
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
                x: STATE.position.0,
                y: STATE.position.1,
                w: 100,
                h: 100,
            },
        ));
        */
    }
}

#[no_mangle]
extern "C" fn draw() {
    unsafe {
        for Player {
            color: Color { r, g, b, a },
            position: (x, y),
            ..
        } in STATE.players.iter().copied()
        {
            draw_rect(r, g, b, a, x, y, 100, 100);
        }
    }
}

extern "C" {
    pub(crate) fn draw_rect(r: u8, g: u8, b: u8, a: u8, x: u32, y: u32, w: u32, h: u32);
}
