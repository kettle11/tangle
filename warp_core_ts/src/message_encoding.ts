let text_encoder = new TextEncoder();
let text_decoder = new TextDecoder();

export class MessageWriterReader {
    output: Uint8Array;
    data_view: DataView;
    offset: number = 0;

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
        let result = this.output.slice(this.offset, this.offset + length);
        this.offset += length;
        return result;
    }

    write_string(string: string) {
        let length = text_encoder.encodeInto(string, this.output.subarray(this.offset + 4)).written!;
        this.data_view.setUint32(this.offset, length);
        this.offset += length + 4;
    }

    read_string(): string {
        let length = this.read_u32();
        let result = text_decoder.decode(this.output.subarray(this.offset, this.offset + length));
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

    write_f64(v: number) {
        this.data_view.setFloat64(this.offset, v);
        this.offset += 8;
    }

    read_u8() {
        let result = this.data_view.getUint8(this.offset);
        this.offset += 1;
        return result;
    }

    read_u16() {
        let result = this.data_view.getUint16(this.offset);
        this.offset += 2;
        return result;
    }

    read_u32() {
        let result = this.data_view.getUint32(this.offset);
        this.offset += 4;
        return result;
    }

    read_f32() {
        let result = this.data_view.getFloat32(this.offset);
        this.offset += 4;
        return result;
    }

    read_f64() {
        let result = this.data_view.getFloat64(this.offset);
        this.offset += 8;
        return result;
    }
}
