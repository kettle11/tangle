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
  constructor() {
    this._peers_to_join = /* @__PURE__ */ new Set();
    this._current_state = 2 /* Disconnected */;
    this._peers = /* @__PURE__ */ new Map();
    this._configuration = {};
    this._current_room_name = "";
    this.outgoing_data_chunk = new Uint8Array(MAX_MESSAGE_SIZE + 5);
    this._artificial_delay = 0;
    this.my_id = 0;
  }
  static async setup(_configuration) {
    let room = new Room();
    await room._setup_inner(_configuration);
    return room;
  }
  message_peer_inner(peer, data) {
    if (!(peer.data_channel.readyState === "open")) {
      return;
    }
    let total_length = data.byteLength;
    if (total_length > MAX_MESSAGE_SIZE) {
      this.outgoing_data_chunk[0] = 1 /* MultiPartStart */;
      new DataView(this.outgoing_data_chunk.buffer).setUint32(1, total_length);
      this.outgoing_data_chunk.set(data.subarray(0, MAX_MESSAGE_SIZE), 5);
      peer.data_channel.send(this.outgoing_data_chunk);
      let data_offset = data.subarray(MAX_MESSAGE_SIZE);
      while (data_offset.byteLength > 0) {
        length = Math.min(data_offset.byteLength, MAX_MESSAGE_SIZE);
        this.outgoing_data_chunk[0] = 2 /* MultiPartContinuation */;
        this.outgoing_data_chunk.set(data_offset.subarray(0, length), 1);
        data_offset = data_offset.subarray(length);
        peer.data_channel.send(this.outgoing_data_chunk.subarray(0, length + 1));
      }
    } else {
      this.outgoing_data_chunk[0] = 3 /* SinglePart */;
      this.outgoing_data_chunk.set(data, 1);
      peer.data_channel.send(this.outgoing_data_chunk.subarray(0, data.byteLength + 1));
    }
  }
  send_message(data, peer_id) {
    if (peer_id) {
      let peer = this._peers.get(peer_id);
      this.message_peer_inner(peer, data);
    } else {
      for (let [_, peer] of this._peers) {
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
  async _setup_inner(room__configuration) {
    var _a, _b;
    onhashchange = (event) => {
      if (this._current_room_name != document.location.hash.substring(1)) {
        location.reload();
        this._current_room_name = document.location.hash.substring(1);
      }
    };
    this._configuration = room__configuration;
    (_a = this._configuration).name ?? (_a.name = "");
    (_b = this._configuration).server_url ?? (_b.server_url = "tangle-server.fly.dev");
    const server_socket = new WebSocket("wss://" + this._configuration.server_url);
    server_socket.onopen = () => {
      console.log("[room] Connection established with server");
      console.log("[room] Requesting to join room: ", this._configuration.name);
      server_socket.send(JSON.stringify({ "join_room": document.location.hash.substring(1) }));
    };
    server_socket.onmessage = async (event) => {
      const last_index = event.data.lastIndexOf("}");
      const json = event.data.substring(0, last_index + 1);
      const message = JSON.parse(json);
      let peer_ip = event.data.substring(last_index + 1).trim();
      let peer_id = compute_id_from_ip(peer_ip);
      if (message.room_name) {
        console.log("[room] Entering room: ", message.room_name);
        this._current_state = 0 /* Joining */;
        let peers_to_join_ids = message.peers.map(compute_id_from_ip);
        this._peers_to_join = new Set(peers_to_join_ids);
        this._configuration.on_state_change?.(this._current_state);
        for (const [key, value] of this._peers) {
          this._peers_to_join.delete(key);
        }
        this.check_if_joined();
        document.location = document.location.origin.toString() + "#" + message.room_name;
        this._current_room_name = message.room_name;
        console.log("MY IP: ", message.your_ip);
        this.my_id = compute_id_from_ip(message.your_ip);
      } else if (message.join_room) {
        console.log("[room] Peer joining room: ", peer_id);
        this.make_rtc_peer_connection(peer_ip, peer_id, server_socket);
      } else if (message.offer) {
        let peer_connection = this.make_rtc_peer_connection(peer_ip, peer_id, server_socket);
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
        let disconnected_peer_id = compute_id_from_ip(message.disconnected_peer_id);
        console.log("[room] Peer left: ", disconnected_peer_id);
        this.remove_peer(disconnected_peer_id, message.time);
        this._peers_to_join.delete(disconnected_peer_id);
        this.check_if_joined();
      }
    };
    server_socket.onclose = (event) => {
      this._current_state = 2 /* Disconnected */;
      this._peers_to_join.clear();
      this._peers.clear();
      if (event.wasClean) {
        console.log(`[room] Server connection closed cleanly, code=${event.code} reason=${event.reason}`);
      } else {
        console.log("[room] Connection died");
      }
      this._configuration.on_state_change?.(this._current_state);
    };
    server_socket.onerror = function(error) {
      console.log(`[room] Server socket error ${error}`);
    };
  }
  check_if_joined() {
    if (this._current_state == 0 /* Joining */ && this._peers_to_join.size == 0) {
      this._current_state = 1 /* Connected */;
      this._configuration.on_state_change?.(this._current_state);
    }
  }
  make_rtc_peer_connection(peer_ip, peer_id, server_socket) {
    const ICE_SERVERS = [
      { urls: "stun:stun1.l.google.com:19302" }
    ];
    const peer_connection = new RTCPeerConnection({ "iceServers": ICE_SERVERS });
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
    peer_connection.onnegotiationneeded = async (event) => {
      console.log("[room] Negotiation needed");
      const offer = await peer_connection.createOffer();
      await peer_connection.setLocalDescription(offer);
      server_socket.send(JSON.stringify({ "offer": offer, "destination": peer_ip }));
    };
    peer_connection.onsignalingstatechange = (event) => {
      console.log("[room] Signaling state changed: ", peer_connection.signalingState);
    };
    peer_connection.onconnectionstatechange = (event) => {
      console.log("[room] Connection state changed: ", peer_connection.connectionState);
    };
    peer_connection.ondatachannel = (event) => {
      let data_channel2 = event.channel;
    };
    data_channel.onopen = (event) => {
      this._peers_to_join.delete(peer_id);
      this._peers.get(peer_id).ready = true;
      this._configuration.on_peer_joined?.(peer_id);
      this.check_if_joined();
    };
    data_channel.onmessage = (event) => {
      if (this._peers.get(peer_id)) {
        if (event.data.byteLength > 0) {
          let message_data = new Uint8Array(event.data);
          switch (message_data[0]) {
            case 3 /* SinglePart */: {
              setTimeout(() => {
                this._configuration.on_message?.(peer_id, message_data.subarray(1));
              }, this._artificial_delay);
              break;
            }
            case 1 /* MultiPartStart */: {
              let data = new DataView(message_data.buffer, 1);
              let length2 = data.getUint32(0);
              let peer = this._peers.get(peer_id);
              peer.latest_message_data = new Uint8Array(length2);
              this.multipart_data_received(peer, message_data.subarray(5));
              break;
            }
            case 2 /* MultiPartContinuation */: {
              let peer = this._peers.get(peer_id);
              this.multipart_data_received(peer, message_data.subarray(1));
            }
          }
        }
      } else {
        console.error("DISCARDING MESSAGE FROM PEER: ", event.data);
      }
    };
    this._peers.set(peer_id, { id: peer_id, connection: peer_connection, data_channel, ready: false, latest_message_data: new Uint8Array(0), latest_message_offset: 0 });
    return peer_connection;
  }
  multipart_data_received(peer, data) {
    peer.latest_message_data.set(data, peer.latest_message_offset);
    peer.latest_message_offset += data.byteLength;
    if (peer.latest_message_offset == peer.latest_message_data.length) {
      let data2 = peer.latest_message_data;
      setTimeout(() => {
        this._configuration.on_message?.(peer.id, data2);
      }, this._artificial_delay);
      peer.latest_message_offset = 0;
      peer.latest_message_data = new Uint8Array(0);
    }
  }
  remove_peer(peer_id, time) {
    let peer = this._peers.get(peer_id);
    if (peer) {
      peer.connection.close();
      this._peers.delete(peer_id);
      this._configuration.on_peer_left?.(peer_id, time);
    }
  }
};

// src/offline_tangle.ts
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
var OfflineTangle = class {
  constructor() {
    /// The user Wasm that Tangle is syncing 
    this.wasm_instance = void 0;
    this.current_time = 0;
    this._recurring_call_interval = 0;
    this.recurring_call_time = 0;
    this._recurring_call_name = "fixed_update";
    this._actions = [];
    this.function_calls = [];
    this._imports = {};
    this._rollback_strategy = 1 /* Granular */;
    this._upcoming_function_calls = new Array();
    // Optionally track hashes after each function call
    this.hash_tracking = true;
  }
  static async setup(wasm_binary, imports, recurring_call_interval, rollback_strategy) {
    let decoder = new TextDecoder();
    let imports_tangle_wasm = {
      env: {
        external_log: function(pointer, length2) {
          let memory = OfflineTangle._tangle_wasm?.instance.exports.memory;
          const message_data = new Uint8Array(memory.buffer, pointer, length2);
          const decoded_string = decoder.decode(new Uint8Array(message_data));
          console.log(decoded_string);
        },
        external_error: function(pointer, length2) {
          let memory = OfflineTangle._tangle_wasm?.instance.exports.memory;
          const message_data = new Uint8Array(memory.buffer, pointer, length2);
          const decoded_string = decoder.decode(new Uint8Array(message_data));
          console.error(decoded_string);
        }
      }
    };
    OfflineTangle._tangle_wasm ?? (OfflineTangle._tangle_wasm = await WebAssembly.instantiateStreaming(fetch("rust_utilities.wasm"), imports_tangle_wasm));
    if (!rollback_strategy) {
      rollback_strategy = 0 /* WasmSnapshots */;
    }
    let tangle = new OfflineTangle();
    tangle._rollback_strategy = rollback_strategy;
    tangle._recurring_call_interval = recurring_call_interval;
    tangle._imports = imports;
    wasm_binary = await process_binary(wasm_binary, true, rollback_strategy == 1 /* Granular */);
    if (rollback_strategy == 1 /* Granular */) {
      tangle._imports.wasm_guardian = {
        on_store: (location2, size) => {
          if (location2 + size > tangle.wasm_instance.instance.exports.memory.buffer.byteLength) {
            console.log("OUT OF BOUNDS MEMORY SIZE IN PAGES: ", (location2 + size) / WASM_PAGE_SIZE);
            console.error("MEMORY OUT OF BOUNDS!: ", location2 + size);
          } else {
            let memory = tangle.wasm_instance.instance.exports.memory;
            let old_value = new Uint8Array(new Uint8Array(memory.buffer, location2, size));
            tangle._actions.push({
              action_type: 0 /* Store */,
              location: location2,
              old_value
              /* hash_before: tangle.hash() */
            });
          }
        },
        on_grow: (pages) => {
          console.log("on_grow called: ", pages);
          let memory = tangle.wasm_instance.instance.exports.memory;
          console.log("NEW MEMORY SIZE IN PAGES: ", memory.buffer.byteLength / WASM_PAGE_SIZE + 1);
          tangle._actions.push({
            action_type: 1 /* Grow */,
            old_page_count: memory.buffer.byteLength / WASM_PAGE_SIZE
            /* hash_before: tangle.hash() */
          });
        },
        on_global_set: (id) => {
          let global_id = "wg_global_" + id;
          tangle._actions.push({ action_type: 2 /* GlobalSet */, global_id, old_value: tangle.wasm_instance?.instance.exports[global_id] });
        }
      };
    }
    let wasm_instance = await WebAssembly.instantiate(wasm_binary, tangle._imports);
    console.log("HEAP SIZE: ", wasm_instance.instance.exports.memory.buffer.byteLength);
    tangle.wasm_instance = wasm_instance;
    return tangle;
  }
  async assign_memory(new_memory_data) {
    let mem = this.wasm_instance?.instance.exports.memory;
    let page_diff = (new_memory_data.byteLength - mem.buffer.byteLength) / WASM_PAGE_SIZE;
    if (page_diff < 0) {
      let old_instance = this.wasm_instance.instance;
      this.wasm_instance.instance = await WebAssembly.instantiate(this.wasm_instance.module, this._imports);
      page_diff = (new_memory_data.byteLength - (this.wasm_instance?.instance.exports.memory).buffer.byteLength) / WASM_PAGE_SIZE;
      for (const [key, v] of Object.entries(old_instance.exports)) {
        if (key.slice(0, 3) == "wg_") {
          this.wasm_instance.instance.exports[key].value = v;
        }
      }
    }
    let old_memory = this.wasm_instance?.instance.exports.memory;
    if (page_diff > 0) {
      old_memory.grow(page_diff);
    }
    new Uint8Array(old_memory.buffer).set(new_memory_data);
  }
  async reset_with_new_program(wasm_binary, current_time) {
    console.log("RESETTING WITH NEW PROGRAM-----------");
    wasm_binary = await process_binary(wasm_binary, true, this._rollback_strategy == 1 /* Granular */);
    this.wasm_instance = await WebAssembly.instantiate(wasm_binary, this._imports);
    console.log("BINARY HASH: ", this.hash_data(wasm_binary));
    this._actions = [];
    this.function_calls = [];
    this.current_time = current_time;
    this.recurring_call_time = 0;
  }
  /// Restarts the Tangle with a new memory.
  async reset_with_wasm_memory(new_memory_data, new_globals_data, current_time, recurring_call_time) {
    this.assign_memory(new_memory_data);
    let exports = this.wasm_instance.instance.exports;
    for (const [key, value] of new_globals_data) {
      exports[`wg_global_${key}`].value = value;
    }
    this._actions = [];
    this.function_calls = [];
    this.current_time = current_time;
    this.recurring_call_time = recurring_call_time;
  }
  remove_history_before(time) {
    let to_remove = 0;
    let i = 0;
    for (i = 0; i < this.function_calls.length; i++) {
      let f = this.function_calls[i];
      if (f.time_stamp.time < time) {
        to_remove += f.actions_caused;
      } else {
        break;
      }
    }
    this._actions.splice(0, to_remove);
    this.function_calls.splice(0, i - 1);
  }
  async _revert_actions(actions_to_remove) {
    let memory = this.wasm_instance?.instance.exports.memory;
    let to_rollback = this._actions.splice(this._actions.length - actions_to_remove, actions_to_remove);
    for (let i = to_rollback.length - 1; i >= 0; i--) {
      let action = to_rollback[i];
      switch (action.action_type) {
        case 0 /* Store */: {
          let destination = new Uint8Array(memory.buffer, action.location, action.old_value.byteLength);
          destination.set(action.old_value);
          break;
        }
        case 1 /* Grow */: {
          console.log("ROLLING BACK GROW!");
          await this.assign_memory(new Uint8Array(memory.buffer, 0, action.old_page_count * WASM_PAGE_SIZE));
          memory = this.wasm_instance.instance.exports.memory;
          break;
        }
        case 2 /* GlobalSet */: {
          (this.wasm_instance?.instance.exports[action.global_id]).value = action.old_value;
          break;
        }
      }
    }
  }
  steps_remaining(time_to_progress) {
    return (this.current_time + time_to_progress - this.recurring_call_time) / this._recurring_call_interval;
  }
  async progress_time(time_progressed) {
    this.current_time += time_progressed;
    if (this._recurring_call_name && this._recurring_call_interval > 0) {
      while (this.current_time - this.recurring_call_time > this._recurring_call_interval) {
        this.recurring_call_time += this._recurring_call_interval;
        let time_stamp = {
          time: this.recurring_call_time,
          player_id: 0
        };
        this._upcoming_function_calls.push({
          function_name: this._recurring_call_name,
          time_stamp,
          args: []
        });
      }
    }
    this._upcoming_function_calls.sort((a, b) => time_stamp_compare(a.time_stamp, b.time_stamp));
    let start_time = performance.now();
    while (this._upcoming_function_calls[0] && Math.sign(this._upcoming_function_calls[0].time_stamp.time - this.current_time) == -1) {
      let function_call = this._upcoming_function_calls.shift();
      await this._call_inner(function_call.function_name, function_call.time_stamp, function_call.args);
      let time_now = performance.now();
      if (start_time - time_now > time_progressed * 0.75) {
        console.log("[tangle] Bailing out of simulation to avoid missed frames");
        break;
      }
    }
  }
  async _apply_snapshot(wasm_snapshot_before) {
    if (wasm_snapshot_before) {
      this.assign_memory(wasm_snapshot_before.memory);
      let values = Object.values(this.wasm_instance.instance.exports);
      for (let j = 0; j < wasm_snapshot_before.globals.length; j++) {
        values[wasm_snapshot_before.globals[j][0]].value = wasm_snapshot_before.globals[j][1];
      }
    }
  }
  _get_wasm_snapshot() {
    let globals = new Array();
    let j = 0;
    for (const [key, v] of Object.entries(this.wasm_instance.instance.exports)) {
      if (key.slice(0, 3) == "wg_") {
        globals.push([j, v.value]);
      }
      j += 1;
    }
    return {
      // This nested Uint8Array constructor creates a deep copy.
      memory: new Uint8Array(new Uint8Array(this.wasm_instance.instance.exports.memory.buffer)),
      globals
    };
  }
  async _call_inner(function_name, time_stamp, args) {
    if (!this.wasm_instance?.instance.exports[function_name]) {
      return 0;
    }
    let i = this.function_calls.length;
    let actions_to_remove = 0;
    for (; i > 0; i--) {
      let function_call2 = this.function_calls[i - 1];
      if (time_stamp_compare(function_call2.time_stamp, time_stamp) == -1) {
        if (this.function_calls[i]) {
          await this._revert_actions(actions_to_remove);
          let wasm_snapshot_before = this.function_calls[i].wasm_snapshot_before;
          if (wasm_snapshot_before) {
            this._apply_snapshot(wasm_snapshot_before);
          }
        }
        break;
      }
      actions_to_remove += function_call2.actions_caused;
    }
    let before = this._actions.length;
    let function_call = this.wasm_instance?.instance.exports[function_name];
    if (function_call) {
      let wasm_snapshot_before;
      if (this._rollback_strategy == 0 /* WasmSnapshots */) {
        wasm_snapshot_before = this._get_wasm_snapshot();
      }
      function_call(...args);
      let after = this._actions.length;
      if (after - before > 0 || this._rollback_strategy == 0 /* WasmSnapshots */) {
        let hash_after;
        if (this.hash_tracking) {
          hash_after = this.hash();
        }
        this.function_calls.splice(i, 0, {
          name: function_name,
          args,
          time_stamp,
          actions_caused: after - before,
          wasm_snapshot_before,
          hash_after
        });
      }
    }
    for (let j = i + 1; j < this.function_calls.length; j++) {
      let f = this.function_calls[j];
      let wasm_snapshot_before;
      if (this._rollback_strategy == 0 /* WasmSnapshots */) {
        wasm_snapshot_before = this._get_wasm_snapshot();
      }
      let before2 = this._actions.length;
      (this.wasm_instance?.instance.exports[f.name])(...f.args);
      if (this.hash_tracking) {
        f.hash_after = this.hash();
      }
      let after = this._actions.length;
      f.actions_caused = after - before2;
      f.wasm_snapshot_before = wasm_snapshot_before;
    }
    return i;
  }
  /// Returns the function call of this instance.
  async call_with_time_stamp(time_stamp, function_name, args) {
    this._upcoming_function_calls.push({
      function_name,
      args,
      time_stamp
    });
  }
  /// Call a function but ensure its results do not persist and cannot cause a desync.
  /// This can be used for things like drawing or querying from the Wasm
  async call_and_revert(function_name, args) {
    let before = this._actions.length;
    let snapshot;
    if (this._rollback_strategy == 0 /* WasmSnapshots */) {
      snapshot = this._get_wasm_snapshot();
    }
    (this.wasm_instance?.instance.exports[function_name])(...args);
    if (snapshot) {
      this._apply_snapshot(snapshot);
    }
    let after = this._actions.length;
    await this._revert_actions(after - before);
  }
  // TODO: These are just helpers and aren't that related to the rest of the code in this:
  gzip_encode(data_to_compress) {
    let memory = OfflineTangle._tangle_wasm?.instance.exports.memory;
    let exports = OfflineTangle._tangle_wasm.instance.exports;
    let pointer = exports.reserve_space(data_to_compress.byteLength);
    const destination = new Uint8Array(memory.buffer, pointer, data_to_compress.byteLength);
    destination.set(new Uint8Array(data_to_compress));
    exports.gzip_encode();
    let result_pointer = new Uint32Array(memory.buffer, pointer, 2);
    let result_data = new Uint8Array(memory.buffer, result_pointer[0], result_pointer[1]);
    console.log("COMPRESSED LENGTH: ", result_data.byteLength);
    console.log("COMPRESSION RATIO: ", data_to_compress.byteLength / result_data.byteLength);
    return result_data;
  }
  gzip_decode(data_to_decode) {
    let memory = OfflineTangle._tangle_wasm?.instance.exports.memory;
    let instance = OfflineTangle._tangle_wasm.instance.exports;
    let pointer = instance.reserve_space(data_to_decode.byteLength);
    const destination = new Uint8Array(memory.buffer, pointer, data_to_decode.byteLength);
    destination.set(data_to_decode);
    instance.gzip_decode();
    let result_pointer = new Uint32Array(memory.buffer, pointer, 2);
    let result_data = new Uint8Array(memory.buffer, result_pointer[0], result_pointer[1]);
    return new Uint8Array(result_data);
  }
  hash() {
    let data_to_hash = new Uint8Array(this.wasm_instance.instance.exports.memory.buffer);
    return this.hash_data(data_to_hash);
  }
  /*
  print_globals() {
      for (const [key, v] of Object.entries(this.wasm_instance!.instance.exports)) {
          if (key.slice(0, 3) == "wg_") {
              console.log("GLOBAL: ", [key, v.value]);
          }
      }
  }
  */
  hash_data(data_to_hash) {
    let memory = OfflineTangle._tangle_wasm?.instance.exports.memory;
    let instance = OfflineTangle._tangle_wasm.instance.exports;
    let pointer = instance.reserve_space(data_to_hash.byteLength);
    const destination = new Uint8Array(memory.buffer, pointer, data_to_hash.byteLength);
    destination.set(new Uint8Array(data_to_hash));
    instance.xxh3_128_bit_hash();
    let hashed_result = new Uint8Array(new Uint8Array(memory.buffer, pointer, 16));
    return hashed_result;
  }
};
async function process_binary(wasm_binary, export_globals, track_changes) {
  if (!(export_globals || track_changes)) {
    return wasm_binary;
  }
  let length2 = wasm_binary.byteLength;
  let pointer = (OfflineTangle._tangle_wasm?.instance.exports.reserve_space)(length2);
  let memory = OfflineTangle._tangle_wasm?.instance.exports.memory;
  const data_location = new Uint8Array(memory.buffer, pointer, length2);
  data_location.set(new Uint8Array(wasm_binary));
  (OfflineTangle._tangle_wasm?.instance.exports.prepare_wasm)(export_globals, track_changes);
  let output_ptr = (OfflineTangle._tangle_wasm?.instance.exports.get_output_ptr)();
  let output_len = (OfflineTangle._tangle_wasm?.instance.exports.get_output_len)();
  const output_wasm = new Uint8Array(memory.buffer, output_ptr, output_len);
  return output_wasm;
}
function arrayEquals(a, b) {
  if (a.length != b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] != b[i]) {
      return false;
    }
  }
  return true;
}

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
  read_fixed_raw_bytes(length2) {
    let result = this.output.slice(this.offset, this.offset + length2);
    this.offset += length2;
    return result;
  }
  write_string(string) {
    let length2 = text_encoder.encodeInto(string, this.output.subarray(this.offset + 4)).written;
    this.data_view.setUint32(this.offset, length2);
    this.offset += length2 + 4;
  }
  read_string() {
    let length2 = this.read_u32();
    let result = text_decoder.decode(this.output.subarray(this.offset, this.offset + length2));
    this.offset += length2;
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
  write_f64(v) {
    this.data_view.setFloat64(this.offset, v);
    this.offset += 8;
  }
  read_i64() {
    let result = this.data_view.getBigInt64(this.offset);
    this.offset += 8;
    return result;
  }
  write_i64(v) {
    this.data_view.setBigInt64(this.offset, v);
    this.offset += 8;
  }
  write_tagged_number(number) {
    if (typeof number == "bigint") {
      this.write_u8(NumberTag.I64);
      this.write_i64(number);
    } else {
      this.write_u8(NumberTag.F64);
      this.write_f64(number);
    }
  }
  read_tagged_number() {
    let tag_byte = this.read_u8();
    if (tag_byte === NumberTag.F64) {
      return this.read_f64();
    } else {
      return this.read_i64();
    }
  }
};
var NumberTag = /* @__PURE__ */ ((NumberTag2) => {
  NumberTag2[NumberTag2["F64"] = 0] = "F64";
  NumberTag2[NumberTag2["I64"] = 1] = "I64";
  return NumberTag2;
})(NumberTag || {});

// src/online_tangle.ts
var text_encoder2 = new TextEncoder();
var text_decoder2 = new TextDecoder();
var UserIdType = class {
};
var UserId = new UserIdType();
var Tangle = class {
  constructor() {
    this._buffered_messages = [];
    this._peer_data = /* @__PURE__ */ new Map();
    this.outgoing_message_buffer = new Uint8Array(500);
    this._tangle_state = 0 /* Disconnected */;
    this._current_program_binary = new Uint8Array();
    this._block_reentrancy = false;
    this._enqueued_inner_calls = new Array(Function());
    this._debug_enabled = true;
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
  static async setup(wasm_binary, wasm_imports, recurring_call_interval, on_state_change_callback) {
    let tangle = new Tangle();
    await tangle.setup_inner(wasm_binary, wasm_imports, recurring_call_interval, on_state_change_callback);
    return tangle;
  }
  request_heap() {
    let lowest_latency_peer = this.room.get_lowest_latency_peer();
    if (lowest_latency_peer) {
      this.room.send_message(this._encode_bounce_back_message(), lowest_latency_peer);
      this.room.send_message(this._encode_request_heap_message(), lowest_latency_peer);
    }
  }
  /// This actually encodes globals as well, not just the heap.
  _encode_heap_message() {
    console.log("WASM MODULE SENDING: ", this._tangle.wasm_instance.instance.exports);
    let memory = this._tangle.wasm_instance.instance.exports.memory;
    let encoded_data = this._tangle.gzip_encode(new Uint8Array(memory.buffer));
    let exports = this._tangle.wasm_instance.instance.exports;
    let globals_count = 0;
    for (const [key, v] of Object.entries(exports)) {
      if (key.slice(0, 3) == "wg_") {
        globals_count += 1;
      }
    }
    let heap_message = new Uint8Array(encoded_data.byteLength + 1 + 8 + 8 + 4 + (8 + 4 + 1) * globals_count);
    let message_writer = new MessageWriterReader(heap_message);
    message_writer.write_u8(2 /* SentHeap */);
    message_writer.write_f64(this._tangle.current_time);
    message_writer.write_f64(this._tangle.recurring_call_time);
    console.log("ENCODING RECURRING CALL TIME: ", this._tangle.recurring_call_time);
    message_writer.write_u16(globals_count);
    for (const [key, v] of Object.entries(exports)) {
      if (key.slice(0, 3) == "wg_") {
        let index = parseInt(key.match(/\d+$/)[0]);
        message_writer.write_u32(index);
        message_writer.write_tagged_number(v.value);
      }
    }
    message_writer.write_raw_bytes(encoded_data);
    return heap_message;
  }
  _decode_heap_message(data) {
    let message_reader = new MessageWriterReader(data);
    let current_time = message_reader.read_f64();
    let recurring_call_time = message_reader.read_f64();
    let mutable_globals_length = message_reader.read_u16();
    let global_values = /* @__PURE__ */ new Map();
    for (let i = 0; i < mutable_globals_length; i++) {
      let index = message_reader.read_u32();
      let value = message_reader.read_tagged_number();
      global_values.set(index, value);
    }
    let heap_data = this._tangle.gzip_decode(message_reader.read_remaining_raw_bytes());
    return {
      current_time,
      recurring_call_time,
      heap_data,
      global_values
    };
  }
  _encode_new_program_message(program_data) {
    let encoded_data = this._tangle.gzip_encode(program_data);
    let message = new Uint8Array(encoded_data.byteLength + 1);
    let message_writer = new MessageWriterReader(message);
    message_writer.write_u8(4 /* SetProgram */);
    message_writer.write_raw_bytes(encoded_data);
    return message;
  }
  _decode_new_program_message(data_in) {
    let data = this._tangle.gzip_decode(data_in);
    return data;
  }
  _encode_wasm_call_message(function_string, time, args, hash) {
    let message_writer = new MessageWriterReader(this.outgoing_message_buffer);
    message_writer.write_u8(0 /* WasmCall */);
    message_writer.write_f64(time);
    message_writer.write_u8(args.length);
    for (let i = 0; i < args.length; i++) {
      message_writer.write_f64(args[i]);
    }
    let text_length = text_encoder2.encodeInto(function_string, this.outgoing_message_buffer.subarray(message_writer.offset)).written;
    return this.outgoing_message_buffer.subarray(0, message_writer.offset + text_length);
  }
  _decode_wasm_call_message(data) {
    let message_reader = new MessageWriterReader(data);
    let time = message_reader.read_f64();
    let args_length = message_reader.read_u8();
    let args = new Array(args_length);
    for (let i = 0; i < args.length; i++) {
      args[i] = message_reader.read_f64();
    }
    let hash;
    let function_name = text_decoder2.decode(data.subarray(message_reader.offset));
    return {
      function_name,
      time,
      args,
      hash
    };
  }
  _encode_time_progressed_message(time_progressed) {
    let message_writer = new MessageWriterReader(this.outgoing_message_buffer);
    message_writer.write_u8(3 /* TimeProgressed */);
    message_writer.write_f64(time_progressed);
    return message_writer.get_result_array();
  }
  _decode_time_progressed_message(data) {
    return new DataView(data.buffer, data.byteOffset).getFloat64(0);
  }
  _encode_request_heap_message() {
    this.outgoing_message_buffer[0] = 1 /* RequestHeap */;
    return this.outgoing_message_buffer.subarray(0, 1);
  }
  _encode_bounce_back_message() {
    let writer = new MessageWriterReader(this.outgoing_message_buffer);
    writer.write_u8(6 /* BounceBack */);
    writer.write_f64(Date.now());
    return writer.get_result_array();
  }
  _decode_bounce_back_return(data) {
    let reader = new MessageWriterReader(data);
    return reader.read_f64();
  }
  _encode_share_history() {
    let data = new Uint8Array(5e4);
    let message_writer = new MessageWriterReader(data);
    message_writer.write_u8(5 /* DebugShareHistory */);
    let history_length = this._tangle.function_calls.length;
    for (let i = 0; i < history_length; i++) {
      let function_call = this._tangle.function_calls[i];
      message_writer.write_f64(function_call.time_stamp.time);
      message_writer.write_raw_bytes(function_call.hash_after);
      message_writer.write_string(function_call.name);
    }
    return message_writer.get_result_array();
  }
  _decode_share_history(data) {
    let history = [];
    let message_reader = new MessageWriterReader(data);
    while (message_reader.offset < data.length) {
      let time = message_reader.read_f64();
      let hash = message_reader.read_fixed_raw_bytes(16);
      let function_name = message_reader.read_string();
      history.push({
        time,
        hash,
        function_name
      });
    }
    return history;
  }
  async setup_inner(wasm_binary, wasm_imports, recurring_call_interval, on_state_change_callback) {
    let room_configuration = {
      on_peer_joined: (peer_id) => {
        this._run_inner_function(async () => {
          this._peer_data.set(peer_id, {
            last_sent_message: 0,
            last_received_message: Number.MAX_VALUE,
            round_trip_time: 0
          });
          this.room.send_message(this._encode_bounce_back_message(), peer_id);
        });
      },
      on_peer_left: (peer_id, time) => {
        this._run_inner_function(async () => {
          console.log("REMOVE PEER HERE");
          this._peer_data.delete(peer_id);
          time = (this._tangle.current_time + 1e3) % 500 + this._tangle.current_time;
          if (time < this.earliest_safe_memory_time()) {
            console.error("POTENTIAL DESYNC DUE TO PEER LEAVING!");
          }
          let time_stamp = {
            time,
            player_id: 0
            // 0 is for events sent by the server.
          };
          console.log("CALLING PEER LEFT");
          this._tangle.call_with_time_stamp(time_stamp, "peer_left", [peer_id]);
        });
      },
      on_state_change: (state) => {
        this._run_inner_function(async () => {
          console.log("[tangle] Room state changed: ", RoomState[state]);
          switch (state) {
            case 1 /* Connected */: {
              this.request_heap();
              if (this._peer_data.size == 0) {
                this._tangle_state = 1 /* Connected */;
                on_state_change_callback?.(this._tangle_state, this);
              }
              break;
            }
            case 2 /* Disconnected */: {
              this._tangle_state = 0 /* Disconnected */;
              on_state_change_callback?.(this._tangle_state, this);
              break;
            }
            case 0 /* Joining */: {
              this._tangle_state = 0 /* Disconnected */;
              on_state_change_callback?.(this._tangle_state, this);
              break;
            }
          }
        });
      },
      on_message: async (peer_id, message) => {
        let peer_connected_already = this._peer_data.get(peer_id);
        this._run_inner_function(async () => {
          if (!this._peer_data.get(peer_id)) {
            return;
          }
          let message_type = message[0];
          let message_data = message.subarray(1);
          switch (message_type) {
            case 3 /* TimeProgressed */: {
              let time = this._decode_time_progressed_message(message_data);
              this._peer_data.get(peer_id).last_received_message = time;
              break;
            }
            case 0 /* WasmCall */: {
              let m = this._decode_wasm_call_message(message_data);
              this._peer_data.get(peer_id).last_received_message = m.time;
              let time_stamp = {
                time: m.time,
                player_id: peer_id
              };
              if (this._tangle_state == 2 /* RequestingHeap */) {
                this._buffered_messages.push({
                  function_name: m.function_name,
                  time_stamp,
                  args: m.args
                });
              } else {
                await this._tangle.call_with_time_stamp(time_stamp, m.function_name, m.args);
              }
              break;
            }
            case 1 /* RequestHeap */: {
              let program_message = this._encode_new_program_message(this._current_program_binary);
              this.room.send_message(program_message);
              let heap_message = this._encode_heap_message();
              this.room.send_message(heap_message);
              break;
            }
            case 2 /* SentHeap */: {
              console.log("[tangle] Setting heap");
              let heap_message = this._decode_heap_message(message_data);
              let round_trip_time = this._peer_data.get(peer_id).round_trip_time;
              console.log("[tangle] Approximate round trip offset: ", round_trip_time / 2);
              let current_time = heap_message.current_time;
              console.log("INITIAL RECURRING CALL TIME: ", heap_message.recurring_call_time);
              await this._tangle.reset_with_wasm_memory(
                heap_message.heap_data,
                heap_message.global_values,
                current_time + round_trip_time / 2,
                heap_message.recurring_call_time
              );
              for (let m of this._buffered_messages) {
                await this._tangle.call_with_time_stamp(m.time_stamp, m.function_name, m.args);
              }
              this._buffered_messages = [];
              this._tangle_state = 1 /* Connected */;
              on_state_change_callback?.(this._tangle_state, this);
              break;
            }
            case 4 /* SetProgram */: {
              let round_trip_time = this._peer_data.get(peer_id).round_trip_time;
              console.log("[tangle] Approximate round trip offset: ", round_trip_time / 2);
              console.log("SETTING PROGRAM!");
              let new_program = this._decode_new_program_message(message_data);
              this._current_program_binary = new_program;
              await this._tangle.reset_with_new_program(new_program, round_trip_time / 2);
              console.log("DONE SETTING PROGRAM");
              break;
            }
            case 5 /* DebugShareHistory */: {
              let remote_history = this._decode_share_history(message_data);
              console.log("RECEIVED SHARED HISTORY DUE TO DESYNC");
              console.log("SHARED HISTORY: ", this._decode_share_history(message_data));
              let i = 0;
              let j = 0;
              while (i < this._tangle.function_calls.length && j < remote_history.length) {
                let f0 = this._tangle.function_calls[i];
                let f1 = remote_history[j];
                let time_stamp1 = {
                  time: f1.time,
                  player_id: peer_id
                };
                let comparison = time_stamp_compare(f0.time_stamp, time_stamp1);
                switch (comparison) {
                  case -1: {
                    i += 1;
                    break;
                  }
                  case 1: {
                    j += 1;
                    break;
                  }
                  case 0: {
                    if (!arrayEquals(f0.hash_after, f1.hash)) {
                      console.log("DESYNC. LOCAL INDEX: %d REMOTE INDEX: %d", i, j);
                    }
                    i += 1;
                    j += 1;
                  }
                }
              }
              break;
            }
            case 6 /* BounceBack */: {
              message[0] = 7 /* BounceBackReturn */;
              this.room.send_message(message, peer_id);
              break;
            }
            case 7 /* BounceBackReturn */: {
              let time = this._decode_bounce_back_return(message_data);
              this._peer_data.get(peer_id).round_trip_time = Date.now() - time;
              break;
            }
          }
        }, !peer_connected_already);
      }
    };
    this._tangle = await OfflineTangle.setup(wasm_binary, wasm_imports, recurring_call_interval);
    this.room = await Room.setup(room_configuration);
    this._current_program_binary = wasm_binary;
  }
  set_program(new_program) {
    this._run_inner_function(async () => {
      await this._tangle.reset_with_new_program(
        new_program,
        0
      );
      this._current_program_binary = new_program;
      console.log("SENDING NEW PROGRAM MESSAGE!");
      this.room.send_message(this._encode_new_program_message(new_program));
    });
  }
  _process_args(args) {
    return args.map((a) => {
      if (typeof a != "number") {
        return this.room.my_id;
      } else {
        return a;
      }
    });
  }
  call(function_name, args) {
    this._run_inner_function(async () => {
      let args_processed = this._process_args(args);
      let time_stamp = {
        time: this._tangle.current_time,
        player_id: this.room.my_id
      };
      await this._tangle.call_with_time_stamp(time_stamp, function_name, args_processed);
      this.room.send_message(this._encode_wasm_call_message(function_name, time_stamp.time, args_processed));
      for (let [_, value] of this._peer_data) {
        value.last_sent_message = Math.max(value.last_received_message, time_stamp.time);
      }
    });
  }
  /// This call will have no impact but can be useful to draw or query from the world.
  call_and_revert(function_name, args) {
    this._run_inner_function(async () => {
      let args_processed = this._process_args(args);
      this._tangle.call_and_revert(function_name, args_processed);
    });
  }
  /// Resync with the room, immediately catching up.
  resync() {
    console.log("REQUESTING HEAP!");
    this.request_heap();
  }
  earliest_safe_memory_time() {
    let earliest_safe_memory = this._tangle.recurring_call_time;
    for (let [_, value] of this._peer_data) {
      earliest_safe_memory = Math.min(earliest_safe_memory, value.last_received_message);
    }
    return earliest_safe_memory;
  }
  async _progress_time_inner(time_progressed) {
    await this._tangle.progress_time(time_progressed);
    let earliest_safe_memory = this._tangle.recurring_call_time;
    for (let [peer_id, value] of this._peer_data) {
      earliest_safe_memory = Math.min(earliest_safe_memory, value.last_received_message);
      const KEEP_ALIVE_THRESHOLD = 200;
      if (this._tangle.current_time - value.last_sent_message > KEEP_ALIVE_THRESHOLD) {
        this.room.send_message(this._encode_time_progressed_message(this._tangle.current_time), peer_id);
      }
    }
    this._tangle.remove_history_before(earliest_safe_memory - 100);
  }
  progress_time(time_progressed) {
    this._run_inner_function(async () => {
      await this._progress_time_inner(time_progressed);
    });
  }
  get_memory() {
    return this._tangle.wasm_instance?.instance.exports.memory;
  }
};
export {
  RoomState,
  Tangle,
  UserId
};
//# sourceMappingURL=index.js.map
