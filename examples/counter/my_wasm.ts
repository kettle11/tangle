// This file is AssemblyScript
// Compile with:
// `asc my_wasm.ts --outFile="dist/my_wasm.wasm"`

let number: f64 = 0;

export function increment(v: f64): void {
    number += v;
    report_number_change(number);
}

export function multiply(v: f64): void {
    number *= v;
    report_number_change(number);
}

export function divide(v: f64): void {
    number /= v;
    report_number_change(number);
}

@external("env", "report_number_change")
    declare function report_number_change(number: f64): void