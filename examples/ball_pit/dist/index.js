import { Tangle } from "../../../tangle_ts/dist/tangle.js"

const canvas = document.getElementById("myCanvas");
const context = canvas.getContext("2d");

async function run() {
  const imports = {
    env: {
      set_color: function (r, g, b, a) {
        context.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
      },
      draw_circle: function (x, y, radius) {
        context.beginPath();
        context.arc(x, y, radius, 0, 2 * Math.PI);
        context.fill();
      },
    }
  };

  const result = await Tangle.instantiateStreaming(fetch("my_wasm.wasm"), imports);
  const exports = result.instance.exports;

  canvas.onpointerdown = async (event) => {
    exports.pointer_down(event.clientX, event.clientY);
  };

  async function animation() {
    if (canvas.width != canvas.clientWidth || canvas.height != canvas.clientHeight) {
      canvas.width = canvas.clientWidth;
      canvas.height = canvas.clientHeight;
    }
    context.clearRect(0, 0, context.canvas.width, context.canvas.height);

    // Our Wasm module has a 'fixed_update' function that Tangle recognizes should be repeatedly called
    // as time progresses. By default `fixed_update` is called 60 times per second. 
    // Below when `draw` is called Tangle actually executes the `fixed_update` calls.

    // `callAndRevert` is a special type of function call that has no lasting effects.
    // Anything that occurs within this call is immediately reverted.
    // This allows `draw` to be called at different rates on different clients: perfect for rendering!
    exports.draw.callAndRevert();

    window.requestAnimationFrame(animation);
  }

  animation();
}
run();