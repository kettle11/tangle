// This file is AssemblyScript
// Compile with:
// `asc my_wasm.ts --outFile="dist/my_wasm.wasm"`

// These calls are imports from the host environment that are used to interact with the canvas.
@external("env", "set_color")
    declare function set_color(r: u8, g: u8, b: u8, a: u8): void

@external("env", "draw_circle")
    declare function draw_circle(x: f64, y: f64, radius: f64): void

// Called whenever a user clicks. Each user has a unique ID.
// Spawn a ball when the player clicks.
export function pointer_down(x: u32, y: u32): void {
    new_ball(x as f64, y as f64);
}

// This is called 60 times per second.
export function fixed_update(): void {
    // This function implements some primitive verlet-physics.
    // The physics code is adapted from this wonderful blog post: https://zalo.github.io/blog/constraints/

    for (let i = 0; i < balls.length; ++i) {
        let ball = balls[i];
        // Verlet integration
        let current_position = ball.position;
        ball.position = current_position.add(current_position.sub(ball.previous_position));
        ball.previous_position = current_position;

        // Gravity
        ball.position.y += 0.5;

        // If there are a bunch of balls slowly remove the oldest ones
        if (i < 10 && balls.length > 40) {
            ball.radius -= 0.05;
            if (ball.radius < 1.0) {
                balls.splice(i, 1);
                i -= 1;
            }
        }
    }

    // Push balls apart
    for (let i = 0; i < balls.length; ++i) {
        for (let j = i; j < balls.length; ++j) {
            if (i == j) continue;

            let a = balls[i];
            let b = balls[j];
            let to_next = b.position.sub(a.position);
            let length = to_next.length();

            let total_radius = (a.radius + b.radius);
            if (length < total_radius) {
                let v = to_next.mul_scalar((1.0 / length) * total_radius);
                let offset = to_next.sub(v);

                let o = offset.div_scalar(2);
                a.position = a.position.add(o);
                b.position = b.position.sub(o);
            }
        }
    }

    // Add a floor and walls
    for (let i = 0; i < balls.length; ++i) {
        let ball = balls[i];
        let below_y = (ball.position.y + ball.radius) - 500;
        if (below_y > 0) {
            ball.position.y -= below_y;
        }

        let left = -ball.position.x;
        if (left > 0) {
            ball.position.x += left;
        }

        let right = ball.position.x - 1500;
        if (right > 0) {
            ball.position.x -= right;
        }
    }
}

// To the rest of the application it appears this function is never called.
// This is accomplished by immediately rolling back the results of this draw call.
// In the future this could be passed in a timestamp to render at a higher refresh rate.
export function draw(): void {
    for (let i = 0; i < balls.length; ++i) {
        let ball = balls[i];
        let color = ball.color;
        set_color(color.r, color.g, color.b, 255);
        draw_circle(ball.position.x, ball.position.y, ball.radius);
    }
}

const BALL_MAX_RADIUS = 40.0;
const BALL_MIN_RADIUS = 10.0;

let balls = new Array<Ball>();

new_ball(100, 100);

class Ball {
    position: Point;
    previous_position: Point;
    radius: f64;
    color: Color;

    constructor(position: Point, radius: f64, color: Color) {
        this.position = position;
        this.previous_position = position;
        this.radius = radius;
        this.color = color;
    }
}

function new_ball(x: f64, y: f64): void {
    let position = new Point(x, y);
    let radius = Math.random() * BALL_MAX_RADIUS + BALL_MIN_RADIUS;
    let color = new Color();
    color.r = (Math.random() * 255) as u8;
    color.g = (Math.random() * 255) as u8;
    color.b = (Math.random() * 255) as u8;

    balls.push(new Ball(position, radius, color));
}

class Color {
    r: u8 = 0; g: u8 = 255; b: u8 = 255;
}

class Point {
    x: f64;
    y: f64;

    constructor(x: f64, y: f64) {
        this.x = x;
        this.y = y;
    }

    add(other: Point): Point {
        return new Point(this.x + other.x, this.y + other.y);
    }

    sub(other: Point): Point {
        return new Point(this.x - other.x, this.y - other.y);
    }

    div_scalar(scalar: f64): Point {
        return new Point(this.x / scalar, this.y / scalar);
    }

    mul_scalar(scalar: f64): Point {
        return new Point(this.x * scalar, this.y * scalar);
    }

    length(): f64 {
        return Math.sqrt(this.x * this.x + this.y * this.y);
    }
}