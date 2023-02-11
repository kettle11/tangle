import { WasmSnapshot, TimeStamp } from "./time_machine";

enum NumberTag {
    F64,
    I64,
}

const text_encoder = new TextEncoder();
const text_decoder = new TextDecoder();

export class MessageWriterReader {
    output: Uint8Array;
    data_view: DataView;
    offset = 0;

    constructor(output: Uint8Array) {
        this.output = output;
        this.data_view = new DataView(output.buffer, output.byteOffset);
    }

    get_result_array() {
        return this.output.subarray(0, this.offset);
    }

    write_raw_bytes(bytes: Uint8Array) {
        this.output.subarray(this.offset).set(bytes);
        this.offset += bytes.length;
    }

    read_remaining_raw_bytes() {
        return this.output.subarray(this.offset);
    }

    read_fixed_raw_bytes(length: number) {
        const result = this.output.slice(this.offset, this.offset + length);
        this.offset += length;
        return result;
    }

    write_string(string: string) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const length = text_encoder.encodeInto(string, this.output.subarray(this.offset + 4)).written!;
        this.data_view.setUint32(this.offset, length);
        this.offset += length + 4;
    }

    read_string(): string {
        const length = this.read_u32();
        const result = text_decoder.decode(this.output.subarray(this.offset, this.offset + length));
        this.offset += length;
        return result;
    }

    write_u8(v: number) {
        this.data_view.setUint8(this.offset, v);
        this.offset += 1;
    }

    write_u16(v: number) {
        this.data_view.setUint16(this.offset, v);
        this.offset += 2;
    }

    write_u32(v: number) {
        this.data_view.setUint32(this.offset, v);
        this.offset += 4;
    }

    write_f32(v: number) {
        this.data_view.setFloat32(this.offset, v);
        this.offset += 4;
    }

    read_u8() {
        const result = this.data_view.getUint8(this.offset);
        this.offset += 1;
        return result;
    }

    read_u16() {
        const result = this.data_view.getUint16(this.offset);
        this.offset += 2;
        return result;
    }

    read_u32() {
        const result = this.data_view.getUint32(this.offset);
        this.offset += 4;
        return result;
    }

    read_f32() {
        const result = this.data_view.getFloat32(this.offset);
        this.offset += 4;
        return result;
    }

    read_f64() {
        const result = this.data_view.getFloat64(this.offset);
        this.offset += 8;
        return result;
    }

    write_f64(v: number) {
        this.data_view.setFloat64(this.offset, v);
        this.offset += 8;
    }

    read_i64() {
        const result = this.data_view.getBigInt64(this.offset);
        this.offset += 8;
        return result;
    }

    write_i64(v: bigint) {
        this.data_view.setBigInt64(this.offset, v);
        this.offset += 8;
    }

    write_tagged_number(number: number | bigint) {
        if (typeof number == "bigint") {
            this.write_u8(NumberTag.I64);
            this.write_i64(number);
        } else {
            this.write_u8(NumberTag.F64);
            this.write_f64(number);
        }
    }

    read_tagged_number() {
        const tag_byte = this.read_u8();
        if (tag_byte === NumberTag.F64) {
            return this.read_f64();
        } else {
            return this.read_i64();
        }
    }

    write_wasm_snapshot(snapshot: WasmSnapshot): void {
        this.write_time_stamp(snapshot.time_stamp);

        const globals_count = snapshot.globals.length;
        // Encode all mutable globals
        this.write_u16(globals_count);
        for (const value of snapshot.globals) {
            this.write_u32(value[0]);
            this.write_tagged_number(value[1] as number | bigint);
        }
        this.write_u32(snapshot.memory.byteLength);
        this.write_raw_bytes(snapshot.memory);
    }

    read_wasm_snapshot(): WasmSnapshot {
        const time_stamp = this.read_time_stamp();
        const mutable_globals_length = this.read_u16();

        const globals: Array<[number, unknown]> = [];
        for (let i = 0; i < mutable_globals_length; i++) {
            const index = this.read_u32();
            const value = this.read_tagged_number();
            globals.push([index, value]);
        }

        const bytes_length = this.read_u32();
        const memory = this.read_fixed_raw_bytes(bytes_length);

        return {
            memory,
            globals,
            time_stamp,
        };
    }

    write_time_stamp(time_stamp: TimeStamp) {
        this.write_f64(time_stamp.time);
        this.write_f64(time_stamp.player_id);
    }

    read_time_stamp(): TimeStamp {
        return {
            time: this.read_f64(),
            player_id: this.read_f64()
        }
    }
}
