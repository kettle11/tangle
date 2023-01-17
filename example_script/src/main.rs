fn main() {}

use kmath::*;
use rapier2d::{na::UnitComplex, prelude::*};

#[derive(Copy, Clone)]
struct Color {
    r: u8,
    g: u8,
    b: u8,
    a: u8,
}

struct WorldState {
    players: Vec<Player>,
    rapier: Option<RapierIntegration>,
}

pub struct RapierIntegration {
    gravity: Vec2,
    integration_parameters: IntegrationParameters,
    physics_pipeline: PhysicsPipeline,
    island_manager: IslandManager,
    broad_phase: BroadPhase,
    pub narrow_phase: NarrowPhase,
    impulse_joint_set: ImpulseJointSet,
    multibody_joint_set: MultibodyJointSet,
    ccd_solver: CCDSolver,
    rigid_body_set: RigidBodySet,
    pub collider_set: ColliderSet,
    query_pipeline: QueryPipeline,
}

impl RapierIntegration {
    pub fn new() -> Self {
        Self {
            gravity: Vec2::new(0.0, 9.81),
            integration_parameters: IntegrationParameters::default(),
            physics_pipeline: PhysicsPipeline::new(),
            island_manager: IslandManager::new(),
            broad_phase: BroadPhase::new(),
            narrow_phase: NarrowPhase::new(),
            impulse_joint_set: ImpulseJointSet::new(),
            multibody_joint_set: MultibodyJointSet::new(),
            ccd_solver: CCDSolver::new(),
            rigid_body_set: RigidBodySet::new(),
            collider_set: ColliderSet::new(),
            query_pipeline: QueryPipeline::new(),
        }
    }

    pub fn step(&mut self) {
        let gravity: [f32; 2] = self.gravity.into();
        let gravity = gravity.into();
        self.physics_pipeline.step(
            &gravity,
            &self.integration_parameters,
            &mut self.island_manager,
            &mut self.broad_phase,
            &mut self.narrow_phase,
            &mut self.rigid_body_set,
            &mut self.collider_set,
            &mut self.impulse_joint_set,
            &mut self.multibody_joint_set,
            &mut self.ccd_solver,
            &(),
            &(),
        );

        /*
        for (_, (transform, rigid_body)) in
            world.query::<(&mut Transform, &RapierRigidBody)>().iter()
        {
            let body = &self.rigid_body_set[rigid_body.rigid_body_handle];
            let p: [f32; 2] = body.position().translation.into();
            let r: f32 = body.rotation().angle();

            transform.position = Vec3::new(p[0], p[1], transform.position.z);
            transform.rotation = Quat::from_angle_axis(r, Vec3::Z);
        }
        */

        self.query_pipeline.update(
            &self.island_manager,
            &self.rigid_body_set,
            &self.collider_set,
        );
    }
}

#[derive(Copy, Clone)]
struct Player {
    tile: usize,
    direction: Vec2i,
    position: Vec2i,
    color: Color,
    target: Option<Vec2i>,
}

#[no_mangle]
extern "C" fn add_player(r: u8, g: u8, b: u8, tile: usize) -> usize {
    unsafe {
        STATE.players.push(Player {
            tile,
            direction: Vec2i::ZERO,
            position: Vec2i::ZERO,
            target: None,
            color: Color { r, g, b, a: 255 },
        });
        STATE.players.len() - 1
    }
}

static mut STATE: WorldState = WorldState {
    players: Vec::new(),
    rapier: None,
};

const SPEED: u32 = 10;

#[no_mangle]
extern "C" fn set_x_axis(player: usize, state: u32) {
    unsafe {
        STATE
            .players
            .get_mut(player)
            .map(|p| p.direction.x = state as _);
    }
}

#[no_mangle]
extern "C" fn set_y_axis(player: usize, state: u32) {
    unsafe {
        STATE
            .players
            .get_mut(player)
            .map(|p| p.direction.y = state as _);
    }
}

const WORLD_SCALE_FACTOR: f32 = 0.05;
const BALL_RADIUS: f32 = 3.0;

#[no_mangle]
extern "C" fn pointer_down(player: usize, x: u32, y: u32, v: f32) {
    unsafe {
        /*
        STATE
            .players
            .get_mut(player)
            .map(|p| p.target = Some(Vec2i::new(x as _, y as _)));
            */

        let rapier = STATE.rapier.as_mut().unwrap();
        let rigid_body = RigidBodyBuilder::dynamic()
            .translation(vector![x as _, y as _] * WORLD_SCALE_FACTOR)
            .build();
        let collider = ColliderBuilder::ball(v * BALL_RADIUS)
            .restitution(0.7)
            .build();
        let ball_body_handle = rapier.rigid_body_set.insert(rigid_body);
        rapier.collider_set.insert_with_parent(
            collider,
            ball_body_handle,
            &mut rapier.rigid_body_set,
        );
    }
}

#[no_mangle]
extern "C" fn add_ball(player: usize, x: u32, y: u32, v: f32, r: u8, g: u8, b: u8) {
    initialize_rapier();
    unsafe {
        let rapier = STATE.rapier.as_mut().unwrap();
        let rigid_body = RigidBodyBuilder::dynamic()
            .translation(vector![x as _, y as _] * WORLD_SCALE_FACTOR)
            .build();

        let mut packed_data: u128 = ((r as u128) << 8 * 2) | ((g as u128) << 8) | b as u128;

        let collider = ColliderBuilder::ball(v * BALL_RADIUS)
            .restitution(0.7)
            .user_data(packed_data)
            .build();
        let ball_body_handle = rapier.rigid_body_set.insert(rigid_body);
        rapier.collider_set.insert_with_parent(
            collider,
            ball_body_handle,
            &mut rapier.rigid_body_set,
        );
    }
}

fn initialize_rapier() {
    unsafe {
        if STATE.rapier.is_none() {
            let mut rapier = RapierIntegration::new();

            let (r, g, b) = (255, 0, 0);
            let mut packed_data: u128 = ((r as u128) << 8 * 2) | ((g as u128) << 8) | b;

            // Create the ground
            {
                let collider = ColliderBuilder::cuboid(100.0, 0.1)
                    .translation(vector![0.0, 30.0])
                    .user_data(packed_data)
                    .build();
                rapier.collider_set.insert(collider);

                let collider = ColliderBuilder::cuboid(0.1, 100.0)
                    .translation(vector![0.0, 0.0])
                    .user_data(packed_data)
                    .build();
                rapier.collider_set.insert(collider);

                let collider = ColliderBuilder::cuboid(0.1, 100.0)
                    .translation(vector![30.0, 0.0])
                    .user_data(packed_data)
                    .build();
                rapier.collider_set.insert(collider);
            }

            STATE.rapier = Some(rapier);
        }
    }
}

#[no_mangle]
extern "C" fn fixed_update() {
    unsafe {
        initialize_rapier();
        for player in STATE.players.iter_mut() {
            player.position += player.direction * SPEED as _;

            if let Some(target) = player.target {
                player.position += (target - player.position) / 10;
            }
        }

        STATE.rapier.as_mut().unwrap().step();

        draw();
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
        if STATE.rapier.is_none() {
            return;
        }

        /*
        let tile_size = 26;
        for Player { position, tile, .. } in STATE.players.iter().copied() {
            let tile_x = tile as u32;
            let tile_y = 0;
            draw_image(
                tile_x * tile_size,
                tile_y * tile_size,
                tile_size,
                tile_size,
                position.x as u32 - tile_size * 2,
                position.y as u32 - tile_size * 2,
                tile_size * 4,
                tile_size * 4,
            );
            // draw_rect(r, g, b, a, x, y, 100, 100);
        }
        */

        for collider in STATE.rapier.as_ref().unwrap().collider_set.iter() {
            let p = collider.1.translation() / WORLD_SCALE_FACTOR;
            let user_data = collider.1.user_data;
            let r = (user_data >> 8 * 2) as u8;
            let g = (user_data >> 8) as u8;
            let b = (user_data) as u8;

            match collider.1.shape().as_typed_shape() {
                TypedShape::Ball(ball) => {
                    draw_circle(
                        r,
                        g,
                        b,
                        255,
                        p.x as _,
                        p.y as _,
                        (ball.radius / WORLD_SCALE_FACTOR) as _,
                    );
                }
                TypedShape::Cuboid(c) => {
                    let aabb = c.aabb(collider.1.position());
                    let p = aabb.mins / WORLD_SCALE_FACTOR;
                    let size = (aabb.maxs - aabb.mins) / WORLD_SCALE_FACTOR;

                    draw_rect(r, g, b, 255, p.x as _, p.y as _, size.x as _, size.y as _);
                }
                _ => {}
            }
        }
    }
}

extern "C" {
    pub(crate) fn draw_circle(r: u8, g: u8, b: u8, a: u8, x: f32, y: f32, r: f32);
    pub(crate) fn draw_rect(r: u8, g: u8, b: u8, a: u8, x: f32, y: f32, w: f32, h: f32);
    pub(crate) fn draw_image(sx: u32, yx: u32, sw: u32, sh: u32, x: u32, y: u32, w: u32, h: u32);

}
