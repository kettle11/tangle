// src/room.ts
var RoomState = /* @__PURE__ */ ((RoomState2) => {
  RoomState2[RoomState2["Joining"] = 0] = "Joining";
  RoomState2[RoomState2["Connected"] = 1] = "Connected";
  RoomState2[RoomState2["Disconnected"] = 2] = "Disconnected";
  return RoomState2;
})(RoomState || {});
var MAX_MESSAGE_SIZE = 16e3;
function compute_id_from_ip(ipAddress) {
  let uniqueNumber = 0;
  const parts = ipAddress.split(":");
  const ip = parts[0].split(".");
  const port = parseInt(parts[1], 10);
  for (let i = 0; i < 4; i++) {
    uniqueNumber += parseInt(ip[i], 10) * Math.pow(256, 3 - i);
  }
  uniqueNumber += port;
  return uniqueNumber;
}
var Room = class {
  constructor(rust_utilities) {
    this._peers_to_join = /* @__PURE__ */ new Set();
    this._current_state = 2 /* Disconnected */;
    this._peers = /* @__PURE__ */ new Map();
    this._configuration = {};
    this._outgoing_data_chunk = new Uint8Array(MAX_MESSAGE_SIZE + 5);
    // Default to 1 because 0 conflicts with the 'system' ID.
    this.my_id = 1;
    // Used for testing
    this._artificial_delay = 0;
    this._rust_utilities = rust_utilities;
  }
  static async setup(_configuration, rust_utilities) {
    const room = new Room(rust_utilities);
    await room._setup_inner(_configuration);
    return room;
  }
  message_peer_inner(peer, data) {
    if (!(peer.data_channel.readyState === "open")) {
      return;
    }
    let message_type = 3 /* SinglePart */;
    if (data.byteLength > MAX_MESSAGE_SIZE) {
      message_type = 4 /* SinglePartGzipped */;
      data = this._rust_utilities.gzip_encode(data);
    }
    if (data.byteLength > MAX_MESSAGE_SIZE) {
      this._outgoing_data_chunk[0] = 1 /* MultiPartStart */;
      new DataView(this._outgoing_data_chunk.buffer).setUint32(1, data.byteLength);
      this._outgoing_data_chunk.set(data.subarray(0, MAX_MESSAGE_SIZE), 5);
      peer.data_channel.send(this._outgoing_data_chunk);
      let data_offset = data.subarray(MAX_MESSAGE_SIZE);
      while (data_offset.byteLength > 0) {
        const length = Math.min(data_offset.byteLength, MAX_MESSAGE_SIZE);
        this._outgoing_data_chunk[0] = 2 /* MultiPartContinuation */;
        this._outgoing_data_chunk.set(data_offset.subarray(0, length), 1);
        data_offset = data_offset.subarray(length);
        peer.data_channel.send(this._outgoing_data_chunk.subarray(0, length + 1));
      }
    } else {
      this._outgoing_data_chunk[0] = message_type;
      this._outgoing_data_chunk.set(data, 1);
      peer.data_channel.send(this._outgoing_data_chunk.subarray(0, data.byteLength + 1));
    }
  }
  send_message(data, peer_id) {
    if (peer_id) {
      const peer = this._peers.get(peer_id);
      this.message_peer_inner(peer, data);
    } else {
      for (const peer of this._peers.values()) {
        if (!peer.ready) {
          continue;
        }
        this.message_peer_inner(peer, data);
      }
    }
  }
  get_lowest_latency_peer() {
    return this._peers.entries().next().value?.[0];
  }
  async _setup_inner(room_configuration) {
    var _a, _b, _c;
    this._configuration = room_configuration;
    (_a = this._configuration).server_url ?? (_a.server_url = "tangle-server.fly.dev");
    (_b = this._configuration).room_name ?? (_b.room_name = "");
    (_c = this._configuration).ice_servers ?? (_c.ice_servers = [
      {
        urls: "stun:relay.metered.ca:80"
      },
      {
        urls: "stun:stun1.l.google.com:19302"
      },
      {
        urls: "turn:relay.metered.ca:80",
        username: "acb3fd59dc274dbfd4e9ef21",
        credential: "1zeDaNt7C85INfxl"
      },
      {
        urls: "turn:relay.metered.ca:443",
        username: "acb3fd59dc274dbfd4e9ef21",
        credential: "1zeDaNt7C85INfxl"
      },
      {
        urls: "turn:relay.metered.ca:443?transport=tcp",
        username: "acb3fd59dc274dbfd4e9ef21",
        credential: "1zeDaNt7C85INfxl"
      }
    ]);
    const connect_to_server = () => {
      const server_socket = new WebSocket("wss://" + this._configuration.server_url);
      let keep_alive_interval;
      server_socket.onopen = () => {
        console.log("[room] Connection established with server");
        console.log("[room] Requesting to join room: ", this._configuration.room_name);
        server_socket.send(JSON.stringify({ "join_room": this._configuration.room_name }));
        clearInterval(keep_alive_interval);
        keep_alive_interval = setInterval(function() {
          server_socket.send("keep_alive");
        }, 1e4);
      };
      server_socket.onclose = (event) => {
        if (this._current_state != 2 /* Disconnected */) {
          clearInterval(keep_alive_interval);
          for (const peer_id of this._peers.keys()) {
            this._configuration.on_peer_left?.(peer_id, Date.now());
          }
          this._current_state = 2 /* Disconnected */;
          this._peers_to_join.clear();
          this._peers.clear();
          if (event.wasClean) {
            console.log(`[room] Server connection closed cleanly, code=${event.code} reason=${event.reason}`);
          } else {
            console.log(`[room] Server connection unexpectedly closed. code=${event.code} reason=${event.reason}`);
            console.log("event: ", event);
          }
          this._configuration.on_state_change?.(this._current_state);
        }
        setTimeout(function() {
          console.log("[room] Attempting to reconnect to server...");
          connect_to_server();
        }, 250);
      };
      server_socket.onerror = function(error) {
        console.log(`[room] Server socket error:`, error);
        server_socket.close();
      };
      server_socket.onmessage = async (event) => {
        const last_index = event.data.lastIndexOf("}");
        const json = event.data.substring(0, last_index + 1);
        const message = JSON.parse(json);
        const peer_ip = event.data.substring(last_index + 1).trim();
        const peer_id = compute_id_from_ip(peer_ip);
        if (message.room_name) {
          console.log("[room] Entering room: ", message.room_name);
          this._current_state = 0 /* Joining */;
          const peers_to_join_ids = message.peers.map(compute_id_from_ip);
          this._peers_to_join = new Set(peers_to_join_ids);
          this._configuration.on_state_change?.(this._current_state);
          for (const key of this._peers.keys()) {
            this._peers_to_join.delete(key);
          }
          this.check_if_joined();
          this.my_id = compute_id_from_ip(message.your_ip);
          console.log("[room] My id is: %d", this.my_id);
        } else if (message.join_room) {
          console.log("[room] Peer joining room: ", peer_id);
          this.make_rtc_peer_connection(peer_ip, peer_id, server_socket);
        } else if (message.offer) {
          const peer_connection = this.make_rtc_peer_connection(peer_ip, peer_id, server_socket);
          await peer_connection.setRemoteDescription(new RTCSessionDescription(message.offer));
          const answer = await peer_connection.createAnswer();
          await peer_connection.setLocalDescription(answer);
          server_socket.send(JSON.stringify({ "answer": answer, "destination": peer_ip }));
        } else if (message.answer) {
          const remoteDesc = new RTCSessionDescription(message.answer);
          await this._peers.get(peer_id)?.connection.setRemoteDescription(remoteDesc);
        } else if (message.new_ice_candidate) {
          try {
            await this._peers.get(peer_id)?.connection.addIceCandidate(message.new_ice_candidate);
          } catch (e) {
            console.error("[room] Error adding received ice candidate", e);
          }
        } else if (message.disconnected_peer_id) {
          const disconnected_peer_id = compute_id_from_ip(message.disconnected_peer_id);
          console.log("[room] Peer left: ", disconnected_peer_id);
          this.remove_peer(disconnected_peer_id, message.time);
          this._peers_to_join.delete(disconnected_peer_id);
          this.check_if_joined();
        }
      };
    };
    connect_to_server();
  }
  check_if_joined() {
    if (this._current_state == 0 /* Joining */ && this._peers_to_join.size == 0) {
      this._current_state = 1 /* Connected */;
      this._configuration.on_state_change?.(this._current_state);
    }
  }
  make_rtc_peer_connection(peer_ip, peer_id, server_socket) {
    const peer_connection = new RTCPeerConnection({ "iceServers": this._configuration.ice_servers });
    const data_channel = peer_connection.createDataChannel("sendChannel", { negotiated: true, id: 2, ordered: true });
    data_channel.binaryType = "arraybuffer";
    peer_connection.onicecandidate = (event) => {
      console.log("[room] New ice candidate: ", event.candidate);
      if (event.candidate) {
        console.log(JSON.stringify({ "new_ice_candidate": event.candidate, "destination": peer_ip }));
        server_socket.send(JSON.stringify({ "new_ice_candidate": event.candidate, "destination": peer_ip }));
      }
    };
    peer_connection.onicecandidateerror = (event) => {
      console.log("[room] Ice candidate error: ", event);
    };
    peer_connection.onnegotiationneeded = async () => {
      console.log("[room] Negotiation needed");
      const offer = await peer_connection.createOffer();
      await peer_connection.setLocalDescription(offer);
      server_socket.send(JSON.stringify({ "offer": offer, "destination": peer_ip }));
    };
    peer_connection.onsignalingstatechange = () => {
      console.log("[room] Signaling state changed: ", peer_connection.signalingState);
    };
    peer_connection.onconnectionstatechange = () => {
      console.log("[room] Connection state changed: ", peer_connection.connectionState);
    };
    peer_connection.ondatachannel = (event) => {
      peer.data_channel = event.channel;
    };
    data_channel.onopen = () => {
      this._peers_to_join.delete(peer_id);
      peer.ready = true;
      this._configuration.on_peer_joined?.(peer_id);
      this.check_if_joined();
    };
    data_channel.onmessage = (event) => {
      if (this._peers.get(peer_id)) {
        if (event.data.byteLength > 0) {
          const message_data = new Uint8Array(event.data);
          switch (message_data[0]) {
            case 3 /* SinglePart */: {
              const data = message_data.subarray(1);
              setTimeout(() => {
                this._configuration.on_message?.(peer_id, data);
              }, this._artificial_delay);
              break;
            }
            case 4 /* SinglePartGzipped */: {
              const data = this._rust_utilities.gzip_decode(message_data.subarray(1));
              setTimeout(() => {
                this._configuration.on_message?.(peer_id, data);
              }, this._artificial_delay);
              break;
            }
            case 1 /* MultiPartStart */: {
              const data = new DataView(message_data.buffer, 1);
              const length = data.getUint32(0);
              peer.latest_message_data = new Uint8Array(length);
              this.multipart_data_received(peer, message_data.subarray(5));
              break;
            }
            case 2 /* MultiPartContinuation */: {
              this.multipart_data_received(peer, message_data.subarray(1));
            }
          }
        }
      } else {
        console.error("DISCARDING MESSAGE FROM PEER: ", event.data);
      }
    };
    const peer = { id: peer_id, connection: peer_connection, data_channel, ready: false, latest_message_data: new Uint8Array(0), latest_message_offset: 0 };
    this._peers.set(peer_id, peer);
    return peer_connection;
  }
  multipart_data_received(peer, data) {
    peer.latest_message_data.set(data, peer.latest_message_offset);
    peer.latest_message_offset += data.byteLength;
    if (peer.latest_message_offset == peer.latest_message_data.length) {
      let data2 = peer.latest_message_data;
      data2 = this._rust_utilities.gzip_decode(data2);
      setTimeout(() => {
        this._configuration.on_message?.(peer.id, data2);
      }, this._artificial_delay);
      peer.latest_message_offset = 0;
      peer.latest_message_data = new Uint8Array(0);
    }
  }
  remove_peer(peer_id, time) {
    const peer = this._peers.get(peer_id);
    if (peer) {
      peer.connection.close();
      this._peers.delete(peer_id);
      this._configuration.on_peer_left?.(peer_id, time);
    }
  }
  disconnect() {
    this._server_socket?.close();
  }
};

// src/message_encoding.ts
var text_encoder = new TextEncoder();
var text_decoder = new TextDecoder();
var MessageWriterReader = class {
  constructor(output) {
    this.offset = 0;
    this.output = output;
    this.data_view = new DataView(output.buffer, output.byteOffset);
  }
  get_result_array() {
    return this.output.subarray(0, this.offset);
  }
  write_raw_bytes(bytes) {
    this.output.subarray(this.offset).set(bytes);
    this.offset += bytes.length;
  }
  read_remaining_raw_bytes() {
    return this.output.subarray(this.offset);
  }
  read_fixed_raw_bytes(length) {
    const result = this.output.slice(this.offset, this.offset + length);
    this.offset += length;
    return result;
  }
  write_string(string) {
    const length = text_encoder.encodeInto(string, this.output.subarray(this.offset + 4)).written;
    this.data_view.setUint32(this.offset, length);
    this.offset += length + 4;
  }
  read_string() {
    const length = this.read_u32();
    const result = text_decoder.decode(this.output.subarray(this.offset, this.offset + length));
    this.offset += length;
    return result;
  }
  write_u8(v) {
    this.data_view.setUint8(this.offset, v);
    this.offset += 1;
  }
  write_u16(v) {
    this.data_view.setUint16(this.offset, v);
    this.offset += 2;
  }
  write_u32(v) {
    this.data_view.setUint32(this.offset, v);
    this.offset += 4;
  }
  write_f32(v) {
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
  write_f64(v) {
    this.data_view.setFloat64(this.offset, v);
    this.offset += 8;
  }
  read_i64() {
    const result = this.data_view.getBigInt64(this.offset);
    this.offset += 8;
    return result;
  }
  write_i64(v) {
    this.data_view.setBigInt64(this.offset, v);
    this.offset += 8;
  }
  write_tagged_number(number) {
    if (typeof number == "bigint") {
      this.write_u8(1 /* I64 */);
      this.write_i64(number);
    } else {
      this.write_u8(0 /* F64 */);
      this.write_f64(number);
    }
  }
  read_tagged_number() {
    const tag_byte = this.read_u8();
    if (tag_byte === 0 /* F64 */) {
      return this.read_f64();
    } else {
      return this.read_i64();
    }
  }
  write_wasm_snapshot(snapshot) {
    this.write_time_stamp(snapshot.time_stamp);
    const globals_count = snapshot.globals.length;
    this.write_u16(globals_count);
    for (const value of snapshot.globals) {
      this.write_u32(value[0]);
      this.write_tagged_number(value[1]);
    }
    this.write_u32(snapshot.memory.byteLength);
    this.write_raw_bytes(snapshot.memory);
  }
  read_wasm_snapshot() {
    const time_stamp = this.read_time_stamp();
    const mutable_globals_length = this.read_u16();
    const globals = [];
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
      time_stamp
    };
  }
  write_time_stamp(time_stamp) {
    this.write_f64(time_stamp.time);
    this.write_f64(time_stamp.player_id);
  }
  read_time_stamp() {
    return {
      time: this.read_f64(),
      player_id: this.read_f64()
    };
  }
};

// src/rust_utilities.ts
var decoder = new TextDecoder();
var RustUtilities = class {
  constructor(rust_utilities) {
    this._rust_utilities = rust_utilities;
  }
  static async setup() {
    const imports = {
      env: {
        external_log: function(pointer, length) {
          const memory = rust_utilities.instance.exports.memory;
          const message_data = new Uint8Array(memory.buffer, pointer, length);
          const decoded_string = decoder.decode(new Uint8Array(message_data));
          console.log(decoded_string);
        },
        external_error: function(pointer, length) {
          const memory = rust_utilities.instance.exports.memory;
          const message_data = new Uint8Array(memory.buffer, pointer, length);
          const decoded_string = decoder.decode(new Uint8Array(message_data));
          console.error(decoded_string);
        }
      }
    };
    console.log(import.meta);
    const url = new URL(import.meta.url);
    const url_without_file = url.origin + url.pathname.substring(0, url.pathname.lastIndexOf("/") + 1);
    const final_url = new URL("rust_utilities.wasm", url_without_file);
    const binary = await fetch(final_url).then((response) => response.arrayBuffer());
    const rust_utilities = await WebAssembly.instantiate(binary, imports);
    return new RustUtilities(rust_utilities);
  }
  gzip_decode(data_to_decode) {
    const memory = this._rust_utilities.instance.exports.memory;
    const instance = this._rust_utilities.instance.exports;
    const pointer = instance.reserve_space(data_to_decode.byteLength);
    const destination = new Uint8Array(memory.buffer, pointer, data_to_decode.byteLength);
    destination.set(data_to_decode);
    instance.gzip_decode();
    const result_pointer = new Uint32Array(memory.buffer, pointer, 2);
    const result_data = new Uint8Array(memory.buffer, result_pointer[0], result_pointer[1]);
    return new Uint8Array(result_data);
  }
  // TODO: These are just helpers and aren't that related to the rest of the code in this:
  gzip_encode(data_to_compress) {
    const memory = this._rust_utilities.instance.exports.memory;
    const exports = this._rust_utilities.instance.exports;
    const pointer = exports.reserve_space(data_to_compress.byteLength);
    const destination = new Uint8Array(memory.buffer, pointer, data_to_compress.byteLength);
    destination.set(new Uint8Array(data_to_compress));
    exports.gzip_encode();
    const result_pointer = new Uint32Array(memory.buffer, pointer, 2);
    const result_data = new Uint8Array(memory.buffer, result_pointer[0], result_pointer[1]);
    return result_data;
  }
  hash_data(...data_to_hash) {
    let byteLength = 0;
    for (const data of data_to_hash) {
      byteLength += data.byteLength;
    }
    const memory = this._rust_utilities.instance.exports.memory;
    const instance = this._rust_utilities.instance.exports;
    const pointer = instance.reserve_space(byteLength);
    let offset = 0;
    for (const data of data_to_hash) {
      const destination = new Uint8Array(memory.buffer, pointer + offset, data.byteLength);
      destination.set(new Uint8Array(data));
      offset += data.byteLength;
    }
    instance.xxh3_128_bit_hash();
    const hashed_result = new Uint8Array(new Uint8Array(memory.buffer, pointer, 16));
    return hashed_result;
  }
  hash_snapshot(wasm_snapshot) {
    const header = new Uint8Array(2 + wasm_snapshot.globals.length * (4 + 9));
    const writer = new MessageWriterReader(header);
    const globals_count = wasm_snapshot.globals.length;
    writer.write_u16(globals_count);
    for (const value of wasm_snapshot.globals) {
      writer.write_u32(value[0]);
      writer.write_tagged_number(value[1]);
    }
    const result = this.hash_data(writer.get_result_array(), new Uint8Array(wasm_snapshot.memory.buffer));
    return result;
  }
  process_binary(wasm_binary, export_globals, track_changes) {
    if (!(export_globals || track_changes)) {
      return wasm_binary;
    }
    const length = wasm_binary.byteLength;
    const pointer = this._rust_utilities.instance.exports.reserve_space(length);
    const memory = this._rust_utilities.instance.exports.memory;
    const data_location = new Uint8Array(memory.buffer, pointer, length);
    data_location.set(new Uint8Array(wasm_binary));
    this._rust_utilities.instance.exports.prepare_wasm(export_globals, track_changes);
    const output_ptr = this._rust_utilities.instance.exports.get_output_ptr();
    const output_len = this._rust_utilities.instance.exports.get_output_len();
    const output_wasm = new Uint8Array(memory.buffer, output_ptr, output_len);
    return output_wasm;
  }
};

// src/time_machine.ts
var WASM_PAGE_SIZE = 65536;
function time_stamp_compare(a, b) {
  let v = Math.sign(a.time - b.time);
  if (v != 0) {
    return v;
  }
  v = Math.sign(a.player_id - b.player_id);
  if (v != 0) {
    return v;
  }
  return 0;
}
var decoder2 = new TextDecoder();
var action_log = "";
var debug_mode = false;
var TimeMachine = class {
  constructor(wasm_instance, rust_utilities) {
    this._current_simulation_time = { time: 0, player_id: 0 };
    this._fixed_update_time = 0;
    this._target_time = 0;
    this._events = [];
    this._snapshots = [];
    this._imports = {};
    this._global_indices = [];
    this._exports = [];
    this._export_keys = [];
    // To facilitate simpler storage, serialization, and networking function calls
    // are associated with an index instead of a string.
    this._function_name_to_index = /* @__PURE__ */ new Map();
    this._wasm_instance = wasm_instance;
    this._exports = Object.values(wasm_instance.instance.exports);
    this._export_keys = Object.keys(wasm_instance.instance.exports);
    this.rust_utilities = rust_utilities;
  }
  static async setup(wasm_binary, imports, fixed_update_interval) {
    var _a, _b, _c;
    const rust_utilities = await RustUtilities.setup();
    {
      imports.env ?? (imports.env = {});
      (_a = imports.env).abort ?? (_a.abort = () => {
        console.log("Ignoring call to abort");
      });
      (_b = imports.env).seed ?? (_b.seed = () => {
        return 14;
      });
    }
    let external_log = () => {
      console.log("Not implemented");
    };
    (_c = imports.env).external_log ?? (_c.external_log = (a, b) => external_log(a, b));
    wasm_binary = rust_utilities.process_binary(wasm_binary, true, false);
    const wasm_instance = await WebAssembly.instantiate(wasm_binary, imports);
    const time_machine = new TimeMachine(wasm_instance, rust_utilities);
    console.log("[tangle] Heap size: ", wasm_instance.instance.exports.memory.buffer.byteLength);
    external_log = (pointer, length) => {
      const memory = time_machine._wasm_instance.instance.exports.memory;
      const message_data = new Uint8Array(memory.buffer, pointer, length);
      const decoded_string = decoder2.decode(new Uint8Array(message_data));
      console.log(decoded_string);
    };
    {
      const main = wasm_instance.instance.exports["main"];
      if (main) {
        main();
      }
    }
    time_machine._imports = imports;
    time_machine._fixed_update_interval = fixed_update_interval;
    let j = 0;
    for (const key of Object.keys(wasm_instance.instance.exports)) {
      if (key.slice(0, 3) == "wg_") {
        time_machine._global_indices.push(j);
      }
      time_machine._function_name_to_index.set(key, j);
      if (key == "fixed_update") {
        time_machine._fixed_update_index = j;
      }
      j += 1;
    }
    if (time_machine._fixed_update_index !== void 0) {
      time_machine._fixed_update_interval ?? (time_machine._fixed_update_interval = 1e3 / 60);
    } else {
      time_machine._fixed_update_interval = void 0;
    }
    time_machine._snapshots = [time_machine._get_wasm_snapshot()];
    console.log("\u{1F680}\u23F3 Time Machine Activated \u23F3\u{1F680}");
    return time_machine;
  }
  read_memory(address, length) {
    return new Uint8Array(new Uint8Array(this._wasm_instance.instance.exports.memory.buffer, address, length));
  }
  read_string(address, length) {
    const message_data = this.read_memory(address, length);
    const decoded_string = decoder2.decode(new Uint8Array(message_data));
    return decoded_string;
  }
  get_function_export_index(function_name) {
    return this._function_name_to_index.get(function_name);
  }
  get_function_name(function_index) {
    return this._export_keys[function_index];
  }
  /// Returns the function call of this instance.
  async call_with_time_stamp(function_export_index, args, time_stamp) {
    if (time_stamp_compare(time_stamp, this._snapshots[0].time_stamp) == -1) {
      console.error("[tangle error] Attempting to rollback to before earliest safe time");
      console.error("Event Time: ", time_stamp);
      console.error("Earlieset Snapshot Time: ", this._snapshots[0].time_stamp);
      throw new Error("[tangle error] Attempting to rollback to before earliest safe time");
    }
    this._progress_recurring_function_calls(time_stamp.time);
    let i = this._events.length - 1;
    outer_loop:
      for (; i >= 0; i -= 1) {
        switch (time_stamp_compare(this._events[i].time_stamp, time_stamp)) {
          case -1:
            break outer_loop;
          case 1:
            break;
          case 0: {
            const event2 = this._events[i];
            if (function_export_index != event2.function_export_index || !array_equals(args, event2.args)) {
              console.error("[tangle warning] Attempted to call a function with a duplicate time stamp.");
              console.log("Event Time: ", time_stamp);
              console.log("Function name: ", this.get_function_name(function_export_index));
            }
            return;
          }
        }
      }
    if (time_stamp_compare(time_stamp, this._current_simulation_time) == -1) {
      if (this._need_to_rollback_to_time === void 0 || time_stamp_compare(time_stamp, this._need_to_rollback_to_time) == -1) {
        this._need_to_rollback_to_time = time_stamp;
      }
    }
    const event = {
      function_export_index,
      args,
      time_stamp
    };
    this._events.splice(i + 1, 0, event);
    if (debug_mode) {
      action_log += `Inserting call ${i + 1} ${event.time_stamp.time} ${event.time_stamp.player_id} ${this.get_function_name(event.function_export_index)}
`;
    }
  }
  /// Call a function but ensure its results do not persist and cannot cause a desync.
  /// This can be used for things like drawing or querying from the Wasm
  async call_and_revert(function_export_index, args) {
    const f = this._exports[function_export_index];
    if (f) {
      const snapshot = this._get_wasm_snapshot();
      f(...args);
      await this._apply_snapshot(snapshot);
    }
  }
  _progress_recurring_function_calls(target_time) {
    if (this._fixed_update_interval !== void 0 && this._fixed_update_index !== void 0) {
      while (target_time > this._fixed_update_time) {
        this.call_with_time_stamp(this._fixed_update_index, [], { time: this._fixed_update_time, player_id: 0 });
        this._fixed_update_time += this._fixed_update_interval;
      }
    }
  }
  target_time() {
    return this._target_time;
  }
  // This is used in scenarios where a peer falls too far behind in a simulation. 
  // This lets them have normal visuals until they resync.
  set_target_time(time) {
    this._target_time = time;
  }
  current_simulation_time() {
    return this._current_simulation_time.time;
  }
  /// This lets the simulation run further into the future.
  /// No functions are actually called yet, that's the responsibility of `step`
  progress_time(time) {
    this._target_time += time;
    this._progress_recurring_function_calls(this._target_time);
  }
  /// Simulates one function step forward and returns if there's more work to do.
  /// This gives the calling context an opportunity to manage how much CPU-time is consumed.
  /// Call this is in a loop and if it returns true continue. 
  step() {
    if (this._need_to_rollback_to_time !== void 0) {
      if (debug_mode) {
        action_log += `Target rollback time: ${this._need_to_rollback_to_time.time} ${this._need_to_rollback_to_time.player_id}
`;
      }
      let i2 = this._snapshots.length - 1;
      for (; i2 >= 0; --i2) {
        if (time_stamp_compare(this._need_to_rollback_to_time, this._snapshots[i2].time_stamp) != -1) {
          break;
        }
      }
      const snap_shot = this._snapshots[i2];
      this._apply_snapshot(snap_shot);
      this._snapshots.splice(i2, this._snapshots.length - i2);
      if (debug_mode) {
        action_log += `Rolling back to: ${snap_shot.time_stamp.time} ${snap_shot.time_stamp.player_id}
`;
      }
      this._current_simulation_time = snap_shot.time_stamp;
      this._need_to_rollback_to_time = void 0;
    }
    let i = this._events.length - 1;
    for (; i >= 0; --i) {
      if (time_stamp_compare(this._events[i].time_stamp, this._current_simulation_time) != 1) {
        break;
      }
    }
    i += 1;
    const function_call = this._events[i];
    if (function_call !== void 0 && function_call.time_stamp.time <= this._target_time) {
      const f = this._exports[function_call.function_export_index];
      f(...function_call.args);
      if (debug_mode) {
        function_call.hash = this.hash_wasm_state();
      }
      if (action_log) {
        const event = function_call;
        action_log += `i ${event.time_stamp.time} ${event.time_stamp.player_id} ${this.get_function_name(event.function_export_index)} ${event.hash}
`;
      }
      this._current_simulation_time = function_call.time_stamp;
      return true;
    }
    return false;
  }
  // Take a snapshot. This provides a point in time to rollback to.
  // This should be called after significant computation has been performed.
  take_snapshot() {
    let i = this._events.length - 1;
    for (; i >= 0; --i) {
      const compare = time_stamp_compare(this._events[i].time_stamp, this._current_simulation_time);
      if (compare == -1) {
        return;
      }
      if (compare == 0) {
        this._snapshots.push(this._get_wasm_snapshot());
        return;
      }
    }
  }
  remove_history_before(time) {
    if (debug_mode) {
      return;
    }
    let i = 0;
    for (; i < this._snapshots.length - 1; ++i) {
      if (this._snapshots[i].time_stamp.time >= time) {
        break;
      }
    }
    i -= 1;
    this._snapshots.splice(0, i);
    let j = 0;
    for (; j < this._events.length; ++j) {
      if (time_stamp_compare(this._events[j].time_stamp, this._snapshots[0].time_stamp) != -1) {
        break;
      }
    }
    j -= 1;
    this._events.splice(0, j);
  }
  // `deep` specifies if the memory is deep-copied for this snapshot. 
  _get_wasm_snapshot(deep = true) {
    const globals = [];
    const export_values = Object.values(this._wasm_instance.instance.exports);
    for (const index of this._global_indices) {
      globals.push([index, export_values[index].value]);
    }
    let memory = new Uint8Array(this._wasm_instance.instance.exports.memory.buffer);
    if (deep) {
      memory = new Uint8Array(memory);
    }
    return {
      // This nested Uint8Array constructor creates a deep copy.
      memory,
      globals,
      time_stamp: this._current_simulation_time
    };
  }
  async _apply_snapshot(snapshot) {
    this._assign_memory(snapshot.memory);
    const values = Object.values(this._wasm_instance.instance.exports);
    for (let j = 0; j < snapshot.globals.length; j++) {
      values[snapshot.globals[j][0]].value = snapshot.globals[j][1];
    }
  }
  async _assign_memory(new_memory_data) {
    const mem = this._wasm_instance?.instance.exports.memory;
    let page_diff = (new_memory_data.byteLength - mem.buffer.byteLength) / WASM_PAGE_SIZE;
    if (page_diff < 0) {
      const old_instance = this._wasm_instance.instance;
      this._wasm_instance.instance = await WebAssembly.instantiate(this._wasm_instance.module, this._imports);
      page_diff = (new_memory_data.byteLength - (this._wasm_instance?.instance.exports.memory).buffer.byteLength) / WASM_PAGE_SIZE;
      for (const [key, v] of Object.entries(old_instance.exports)) {
        if (key.slice(0, 3) == "wg_") {
          this._wasm_instance.instance.exports[key].value = v;
        }
      }
    }
    const old_memory = this._wasm_instance?.instance.exports.memory;
    if (page_diff > 0) {
      old_memory.grow(page_diff);
    }
    new Uint8Array(old_memory.buffer).set(new_memory_data);
  }
  encode(first_byte) {
    console.log("[time-machine] Encoding with hash: ", this.hash_wasm_state());
    const snapshot = this._snapshots[0];
    let size = 1 + 8 * 4 + 4 + (4 + 8 + 8 + 1) * this._events.length;
    for (const event of this._events) {
      size += event.args.length * 8;
    }
    size += 8 + 8 + 2 + (4 + 9) * snapshot.globals.length;
    size += 4 + snapshot.memory.buffer.byteLength;
    const writer = new MessageWriterReader(new Uint8Array(size));
    writer.write_u8(first_byte);
    writer.write_f64(this._fixed_update_time);
    writer.write_f64(this._target_time);
    writer.write_time_stamp(snapshot.time_stamp);
    writer.write_u32(this._events.length);
    for (const event of this._events) {
      writer.write_u32(event.function_export_index);
      writer.write_time_stamp(event.time_stamp);
      writer.write_u8(event.args.length);
      for (const arg of event.args) {
        writer.write_f64(arg);
      }
    }
    writer.write_wasm_snapshot(snapshot);
    console.log("[time-machine] Hash of sent snapshot: ", this.rust_utilities.hash_snapshot(snapshot));
    return writer.get_result_array();
  }
  decode_and_apply(reader) {
    this._fixed_update_time = reader.read_f64();
    this._target_time = reader.read_f64();
    this._current_simulation_time = reader.read_time_stamp();
    const events_length = reader.read_u32();
    this._events = new Array(events_length);
    let last_time_stamp = {
      time: -1,
      player_id: 0
    };
    for (let i = 0; i < events_length; ++i) {
      const function_export_index = reader.read_u32();
      const time_stamp = reader.read_time_stamp();
      const args_length = reader.read_u8();
      const args = new Array(args_length);
      for (let j = 0; j < args_length; ++j) {
        args[j] = reader.read_f64();
      }
      this._events[i] = {
        function_export_index,
        time_stamp,
        args
      };
      if (!(time_stamp_compare(last_time_stamp, time_stamp) == -1)) {
        console.error("[time-machine] Error: Incoming time stamps out of order");
      }
      last_time_stamp = time_stamp;
    }
    const wasm_snapshot = reader.read_wasm_snapshot();
    this._apply_snapshot(wasm_snapshot);
    this._snapshots = [wasm_snapshot];
    console.log("[time-machine] Decoded with hash: ", this.hash_wasm_state());
  }
  hash_wasm_state() {
    return this.rust_utilities.hash_snapshot(this._get_wasm_snapshot(false));
  }
  print_history() {
    let history = "";
    let previous_time_stamp = { time: -1, player_id: 0 };
    for (const event of this._events) {
      if (time_stamp_compare(previous_time_stamp, event.time_stamp) != -1) {
        history += "ERROR: OUT OF ORDER TIMESTAMPS\n";
      }
      history += `${event.time_stamp.time} ${event.time_stamp.player_id} ${this.get_function_name(event.function_export_index)} ${event.hash}
`;
      previous_time_stamp = event.time_stamp;
    }
    console.log(action_log);
    console.log(history);
  }
};
function array_equals(a, b) {
  return a.length === b.length && a.every((val, index) => val === b[index]);
}

// src/tangle.ts
var TangleState = /* @__PURE__ */ ((TangleState2) => {
  TangleState2[TangleState2["Disconnected"] = 0] = "Disconnected";
  TangleState2[TangleState2["Connected"] = 1] = "Connected";
  TangleState2[TangleState2["RequestingHeap"] = 2] = "RequestingHeap";
  return TangleState2;
})(TangleState || {});
var UserIdType = class {
};
var UserId = new UserIdType();
var ROUND_TRIP_TIME_ROLLING_AVERAGE_ALPHA = 0.9;
var Tangle = class {
  constructor(time_machine) {
    this._buffered_messages = [];
    this._peer_data = /* @__PURE__ */ new Map();
    this._tangle_state = 0 /* Disconnected */;
    this._current_program_binary = new Uint8Array();
    this._block_reentrancy = false;
    this._enqueued_inner_calls = [];
    this._configuration = {};
    this._outgoing_message_buffer = new Uint8Array(500);
    this._message_time_offset = 0;
    this._last_sent_message = 0;
    this._time_machine = time_machine;
    this._rust_utilities = time_machine.rust_utilities;
  }
  // private _debug_enabled = true;
  static async instanstiate(source, importObject, tangle_configuration) {
    tangle_configuration ?? (tangle_configuration = {});
    tangle_configuration.accept_new_programs ?? (tangle_configuration.accept_new_programs = false);
    const wasm_binary = new Uint8Array(source);
    importObject ?? (importObject = {});
    if (importObject) {
      Object.values(importObject).forEach((moduleImports) => {
        Object.entries(moduleImports).forEach(([importName, importValue]) => {
          if (typeof importValue === "function") {
            moduleImports[importName] = function(...args) {
              const r = importValue(...args);
              if (r !== void 0) {
                console.log("[tangle warning] Tangle prevents WebAssembly imports from returning values because those values are unique per-peer and would cause a desync.");
              }
            };
          }
        });
      });
    }
    const time_machine = await TimeMachine.setup(wasm_binary, importObject, tangle_configuration.fixed_update_interval);
    const tangle = new Tangle(time_machine);
    tangle._configuration = tangle_configuration;
    const exports = await tangle.setup_inner(tangle_configuration.room_name, wasm_binary);
    return {
      instance: {
        exports
      },
      tangle
    };
  }
  static async instantiateStreaming(source, importObject, tangle_configuration) {
    source = await source;
    const binary = await source.arrayBuffer();
    return Tangle.instanstiate(new Uint8Array(binary), importObject, tangle_configuration);
  }
  _change_state(state) {
    if (this._tangle_state != state) {
      if (state == 1 /* Connected */) {
        console.log("\u{1F331} Tangle State: ", TangleState[state]);
        console.log("Learn more about Tangle at https://tanglesync.com");
        this._last_performance_now = performance.now();
      }
      this._tangle_state = state;
      this._configuration.on_state_change_callback?.(state, this);
    }
    this._tangle_state = state;
  }
  async setup_inner(room_name, wasm_binary) {
    room_name ?? (room_name = document.location.href);
    const hash = this._rust_utilities.hash_data(wasm_binary);
    room_name += hash.join("");
    const room_configuration = {
      server_url: this._configuration.room_server,
      ice_servers: this._configuration.ice_servers,
      room_name,
      on_peer_joined: (peer_id) => {
        this._peer_data.set(peer_id, {
          last_received_message: 0,
          round_trip_time: 0,
          estimated_current_time_measurement: 0,
          estimated_current_time: void 0
        });
        this._room.send_message(this._encode_ping_message(), peer_id);
      },
      on_peer_left: (peer_id) => {
        this._run_inner_function(async () => {
          this._peer_data.delete(peer_id);
          let closest_peer = this._room.my_id;
          let peer_distance = this._room.my_id - peer_id;
          for (const peer of this._peer_data.keys()) {
            const diff = peer - peer_id;
            if (diff != 0 && diff < peer_distance) {
              closest_peer = peer;
              peer_distance = diff;
            }
          }
          console.log("[tangle] calling 'peer_left'");
          if (closest_peer == this._room.my_id) {
            this.call("peer_left", peer_id);
          }
        });
      },
      on_state_change: (state) => {
        this._run_inner_function(async () => {
          console.log("[tangle] Room state changed: ", RoomState[state]);
          switch (state) {
            case 1 /* Connected */: {
              this._request_heap();
              if (this._peer_data.size == 0) {
                this._change_state(1 /* Connected */);
              }
              break;
            }
            case 2 /* Disconnected */: {
              this._change_state(0 /* Disconnected */);
              break;
            }
            case 0 /* Joining */: {
              this._change_state(0 /* Disconnected */);
              break;
            }
          }
        });
      },
      on_message: async (peer_id, message) => {
        const peer_connected_already = this._peer_data.get(peer_id);
        this._run_inner_function(async () => {
          const peer = this._peer_data.get(peer_id);
          if (!peer) {
            console.log("[tangle] Rejected message from unconnected peer: ", peer_id);
            return;
          }
          const message_type = message[0];
          const message_data = message.subarray(1);
          switch (message_type) {
            case 1 /* TimeProgressed */: {
              const time = this._decode_time_progressed_message(message_data);
              peer.last_received_message = time;
              break;
            }
            case 0 /* WasmCall */: {
              const m = this._decode_wasm_call_message(message_data);
              peer.last_received_message = m.time;
              const time_stamp = {
                time: m.time,
                player_id: peer_id
              };
              if (this._tangle_state == 2 /* RequestingHeap */) {
                this._buffered_messages.push({
                  function_export_index: m.function_index,
                  time_stamp,
                  args: m.args
                });
              } else {
                console.log("[tangle] Remote Wasm call: ", this._time_machine.get_function_name(m.function_index));
                await this._time_machine.call_with_time_stamp(m.function_index, m.args, time_stamp);
                if (!this._time_machine._fixed_update_interval) {
                  this.progress_time();
                }
              }
              break;
            }
            case 2 /* RequestState */: {
              const heap_message = this._time_machine.encode(4 /* SetHeap */);
              this._room.send_message(heap_message);
              break;
            }
            case 4 /* SetHeap */: {
              if (this._tangle_state != 1 /* Connected */) {
                console.log("[tangle] Applying TimeMachine state from peer");
                const round_trip_time = peer.round_trip_time;
                console.log("[tangle] Approximate round trip offset: ", round_trip_time / 2);
                this._time_machine.decode_and_apply(new MessageWriterReader(message_data));
                for (const m of this._buffered_messages) {
                  await this._time_machine.call_with_time_stamp(m.function_export_index, m.args, m.time_stamp);
                }
                this._buffered_messages = [];
                this._time_machine.progress_time(round_trip_time / 2);
                this._change_state(1 /* Connected */);
              }
              break;
            }
            case 5 /* Ping */: {
              const writer = new MessageWriterReader(this._outgoing_message_buffer);
              writer.write_u8(6 /* Pong */);
              writer.write_raw_bytes(message_data);
              writer.write_f64(this._average_current_time(performance.now()));
              this._room.send_message(writer.get_result_array(), peer_id);
              break;
            }
            case 6 /* Pong */: {
              const { time_sent, current_time } = this._decode_pong_message(message_data);
              const new_round_trip_time = Date.now() - time_sent;
              if (peer.round_trip_time == 0) {
                peer.round_trip_time = new_round_trip_time;
              } else {
                peer.round_trip_time = peer.round_trip_time * ROUND_TRIP_TIME_ROLLING_AVERAGE_ALPHA + (1 - ROUND_TRIP_TIME_ROLLING_AVERAGE_ALPHA) * new_round_trip_time;
              }
              peer.estimated_current_time = current_time + peer.round_trip_time / 2;
              peer.estimated_current_time_measurement = performance.now();
              break;
            }
          }
        }, !peer_connected_already);
      }
    };
    this._room = await Room.setup(room_configuration, this._rust_utilities);
    this._current_program_binary = wasm_binary;
    const export_object = {};
    for (const key of Object.keys(this._time_machine._wasm_instance.instance.exports)) {
      const e = this._time_machine._wasm_instance.instance.exports[key];
      if (typeof e === "function") {
        const wrapped_function = (...args) => {
          this.call(key, ...args);
        };
        wrapped_function.callAndRevert = (...args) => {
          this.call_and_revert(key, ...args);
        };
        export_object[key] = wrapped_function;
      }
    }
    return export_object;
  }
  async _run_inner_function(f, enqueue_condition = false) {
    if (!this._block_reentrancy && !enqueue_condition) {
      this._block_reentrancy = true;
      await f();
      let f1 = this._enqueued_inner_calls.shift();
      while (f1) {
        await f1();
        f1 = this._enqueued_inner_calls.shift();
      }
      this._block_reentrancy = false;
    } else {
      this._enqueued_inner_calls.push(f);
    }
  }
  _request_heap() {
    const lowest_latency_peer = this._room.get_lowest_latency_peer();
    if (lowest_latency_peer) {
      this._change_state(2 /* RequestingHeap */);
      this._room.send_message(this._encode_ping_message(), lowest_latency_peer);
      this._room.send_message(this._encode_request_heap_message(), lowest_latency_peer);
    }
  }
  _encode_wasm_call_message(function_index, time, args) {
    const message_writer = new MessageWriterReader(this._outgoing_message_buffer);
    message_writer.write_u8(0 /* WasmCall */);
    message_writer.write_u32(function_index);
    message_writer.write_f64(time);
    message_writer.write_u8(args.length);
    for (let i = 0; i < args.length; i++) {
      message_writer.write_f64(args[i]);
    }
    return this._outgoing_message_buffer.subarray(0, message_writer.offset);
  }
  _decode_wasm_call_message(data) {
    const message_reader = new MessageWriterReader(data);
    const function_index = message_reader.read_u32();
    const time = message_reader.read_f64();
    const args_length = message_reader.read_u8();
    const args = new Array(args_length);
    for (let i = 0; i < args.length; i++) {
      args[i] = message_reader.read_f64();
    }
    let hash;
    return {
      function_index,
      time,
      args,
      hash
    };
  }
  _encode_time_progressed_message(time_progressed) {
    const message_writer = new MessageWriterReader(this._outgoing_message_buffer);
    message_writer.write_u8(1 /* TimeProgressed */);
    message_writer.write_f64(time_progressed);
    return message_writer.get_result_array();
  }
  _decode_time_progressed_message(data) {
    return new DataView(data.buffer, data.byteOffset).getFloat64(0);
  }
  _encode_request_heap_message() {
    this._outgoing_message_buffer[0] = 2 /* RequestState */;
    return this._outgoing_message_buffer.subarray(0, 1);
  }
  _encode_ping_message() {
    const writer = new MessageWriterReader(this._outgoing_message_buffer);
    writer.write_u8(5 /* Ping */);
    writer.write_f64(Date.now());
    return writer.get_result_array();
  }
  _decode_pong_message(data) {
    const reader = new MessageWriterReader(data);
    const time_sent = reader.read_f64();
    const current_time = reader.read_f64();
    return { time_sent, current_time };
  }
  _process_args(args) {
    return args.map((a) => {
      if (a instanceof UserIdType) {
        return this._room.my_id;
      } else {
        return a;
      }
    });
  }
  _median_round_trip_latency() {
    const latencies = Array.from(this._peer_data.values()).map((peer) => peer.round_trip_time).sort();
    return latencies[Math.floor(latencies.length / 2)];
  }
  call(function_name, ...args) {
    this._run_inner_function(async () => {
      const args_processed = this._process_args(args);
      let median_round_trip_latency = this._median_round_trip_latency();
      if (median_round_trip_latency === void 0 || median_round_trip_latency < 60) {
        median_round_trip_latency = 0;
      }
      median_round_trip_latency = Math.min(median_round_trip_latency, 150);
      const message_time = Math.max(this._last_sent_message, this._time_machine.target_time() + median_round_trip_latency) + this._message_time_offset;
      const time_stamp = {
        time: message_time,
        player_id: this._room.my_id
      };
      this._message_time_offset += 1e-4;
      const function_index = this._time_machine.get_function_export_index(function_name);
      if (function_index !== void 0) {
        await this._time_machine.call_with_time_stamp(function_index, args_processed, time_stamp);
        if (this._tangle_state == 1 /* Connected */) {
          this._room.send_message(this._encode_ping_message());
          this._room.send_message(this._encode_wasm_call_message(function_index, time_stamp.time, args_processed));
        }
        this._last_sent_message = Math.max(this._last_sent_message, time_stamp.time);
      }
    });
    this.progress_time();
  }
  /// This call will have no impact but can be useful to draw or query from the world.
  call_and_revert(function_name, ...args) {
    this.progress_time();
    this._run_inner_function(async () => {
      const args_processed = this._process_args(args);
      const function_index = this._time_machine.get_function_export_index(function_name);
      if (function_index) {
        this._time_machine.call_and_revert(function_index, args_processed);
      }
    });
  }
  /// Resync with the room, immediately catching up.
  resync() {
    this._run_inner_function(() => {
      this._request_heap();
    });
  }
  progress_time() {
    this._run_inner_function(async () => {
      await this._progress_time_inner();
    });
  }
  async _progress_time_inner() {
    const performance_now = performance.now();
    if (this._last_performance_now) {
      const average_current_time = this._average_current_time(performance_now);
      const difference_from_peers = average_current_time - this.current_time(performance_now);
      let time_progressed = performance_now - this._last_performance_now + difference_from_peers;
      time_progressed = Math.max(time_progressed, 1e-3);
      const check_for_resync = true;
      if (check_for_resync && this._tangle_state == 1 /* Connected */) {
        const time_diff = this._time_machine.target_time() + time_progressed - this._time_machine.current_simulation_time();
        if (this._time_machine._fixed_update_interval !== void 0 && time_diff > 3e3) {
          time_progressed = this._time_machine._fixed_update_interval;
          if (this._peer_data.size > 0) {
            console.log("[tangle] Fallen behind, reloading room");
            console.log("Fallen behind amount: ", time_diff);
            location.reload();
          } else {
            console.log("[tangle] Fallen behind but this is a single-player session, so ignoring this");
          }
        }
      }
      await this._time_machine.progress_time(time_progressed);
      const time_budget = time_progressed * 0.7;
      const time_here = performance.now();
      while (this._time_machine.step()) {
        this._time_machine.take_snapshot();
        if (performance.now() - time_here > time_budget) {
          break;
        }
      }
      let earliest_safe_memory = this._time_machine.current_simulation_time();
      if (this._tangle_state == 1 /* Connected */) {
        for (const value of this._peer_data.values()) {
          earliest_safe_memory = Math.min(earliest_safe_memory, value.last_received_message);
        }
        const KEEP_ALIVE_THRESHOLD = 200;
        const current_time = this._time_machine.target_time();
        const difference = current_time - this._last_sent_message;
        if (difference > KEEP_ALIVE_THRESHOLD) {
          this._room.send_message(this._encode_ping_message());
          this._room.send_message(this._encode_time_progressed_message(current_time));
        }
      }
      this._time_machine.remove_history_before(earliest_safe_memory);
      if (time_progressed > 0) {
        this._message_time_offset = 1e-4;
      }
    }
    this._last_performance_now = performance_now;
  }
  _average_current_time(now) {
    let current_time = this._time_machine.target_time();
    if (this._last_performance_now) {
      current_time += now - this._last_performance_now;
    }
    let count = 1;
    if (this._tangle_state == 1 /* Connected */) {
      for (const peer of this._peer_data.values()) {
        if (peer.estimated_current_time) {
          current_time += peer.estimated_current_time + (now - peer.estimated_current_time_measurement);
          count += 1;
        }
      }
    }
    current_time = current_time / count;
    return current_time;
  }
  current_time(now) {
    let time = this._time_machine.target_time();
    if (this._last_performance_now) {
      time += now - this._last_performance_now;
    }
    return time;
  }
  read_memory(address, length) {
    return this._time_machine.read_memory(address, length);
  }
  read_string(address, length) {
    return this._time_machine.read_string(address, length);
  }
  print_history() {
    this._time_machine.print_history();
  }
};
export {
  Tangle,
  TangleState,
  UserId
};
//# sourceMappingURL=tangle.js.map
