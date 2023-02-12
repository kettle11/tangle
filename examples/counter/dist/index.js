
import { Tangle } from "../../../tangle_ts/dist/tangle.js"

async function run() {
  const imports = {
    env: {
      report_number_change: (number) => {
        console.log("Number changed: ", number);
        document.getElementById("count").innerText = number;
      },
    }
  };

  const result = await Tangle.instantiateStreaming(fetch("my_wasm.wasm"), imports);
  const exports = result.instance.exports;

  document.getElementById("increment").onclick = () => {
    exports.increment(1);
  }
  document.getElementById("double").onclick = () => {
    exports.multiply(2);
  }
  document.getElementById("triple").onclick = () => {
    exports.multiply(3);
  }
}
run();