const WASM_PAGE_SIZE = 65536;

async function getWarpCore(wasm_binary, imports_in) {

    let current_time = 0;

    let memory;
    const decoder = new TextDecoder();

    console.log("GETTING WARP CORE");
    let imports = {
        env: {
            external_log: function (pointer, length) {
                const message_data = new Uint8Array(memory.buffer, pointer, length);
                const decoded_string = decoder.decode(new Uint8Array(message_data));
                console.log(decoded_string);
            },
            external_error: function (pointer, length) {
                const message_data = new Uint8Array(memory.buffer, pointer, length);
                const decoded_string = decoder.decode(new Uint8Array(message_data));
                console.error(decoded_string);
            }
        }
    };

    // Use the wasm_guardian Wasm binary to modify the passed in Wasm binary.
    let result = await WebAssembly.instantiateStreaming(fetch("warpcore_mvp.wasm"), imports);
    memory = result.instance.exports.memory;

    // For now there's only one wasm instance at a time
    let wasm_memory;
    let wasm_instance;
    let wasm_module;

    let function_calls = [];
    let actions = [];

    // Prepare the wasm module.
    let length = wasm_binary.byteLength;
    let pointer = result.instance.exports.reserve_space(length);

    const data_location = new Uint8Array(memory.buffer, pointer, length);
    data_location.set(new Uint8Array(wasm_binary));

    result.instance.exports.prepare_wasm();

    let output_ptr = result.instance.exports.get_output_ptr();
    let output_len = result.instance.exports.get_output_len();
    const output_wasm = new Uint8Array(memory.buffer, output_ptr, output_len);

    imports_in.wasm_guardian = {
        on_store: function (location, size) {
            console.log("on_store called: ", location, size);
            let old_value = new Uint8Array(new Uint8Array(wasm_memory.buffer, location, size));
            actions.push({ type: "store", location: location, old_value: old_value, time: current_time });
        },
        on_grow: function (pages) {
            console.log("on_grow called: ", pages);
            actions.push({ type: "grow", old_pages: wasm_memory.buffer.byteLength / WASM_PAGE_SIZE, time: current_time });
        },
        on_global_set: function (id) {
            console.log("on_global_set called: ", id);
            let global_id = "wg_global_" + id;
            actions.push({ type: "global_set", global_id: global_id, old_value: wasm_instance.exports[global_id], time: current_time });
        },
    };

    await WebAssembly.instantiate(output_wasm, imports_in).then(result => {
        actions = [];
        wasm_memory = result.instance.exports.memory;
        wasm_instance = result.instance;
        wasm_module = result.module;

        console.log("INSTANTIATED INSTANCE: ", result.instance);
    });

    // Setup the networked room

    let heap_bytes_remaining = 0;
    let new_heap = null;
    let new_heap_offset = 0;
    let loaded_heap = true;

    const HEAP_CHUNK_SIZE = 16000; // 16kb

    // TODO: Track peers
    let peer_index = 0;
    room_object.setup((peer_id, welcoming) => {
        // on_peer_joined
        peer_index += 1;

        if (!welcoming && loaded_heap) {
            loaded_heap = false;
            room_object.message_specific_peer(peer_id, JSON.stringify({
                message_type: 2,
            }));
        }

        return peer_index;
    }, () => {
        // on_peer_left
    }, (message, peer_id) => {
        // on_message_received

        // If we're loading a multi-part heap from a peer.
        // TODO: This does not account for edge-cases with multiple peers.
        if (heap_bytes_remaining > 0) {
            heap_bytes_remaining -= message.byteLength;

            let m = new Uint8Array(message);

            // TODO: This could instead be copied to the final heap instead of an intermediate heap.

            new_heap.set(m, new_heap_offset);
            new_heap_offset += message.byteLength;

            if (heap_bytes_remaining == 0) {
                console.log("RECEIVED HEAP");

                // Reset state tracking.
                // TODO: Reapply actions that occured after time.

                function_calls = [];
                actions = [];

                let page_diff = (new_heap.byteLength - wasm_memory.buffer.byteLength) / WASM_PAGE_SIZE;
                if (page_diff > 0) {
                    wasm_memory.grow(page_diff);
                }

                new Uint8Array(wasm_memory.buffer).set(new_heap);
                new_heap = null;
                loaded_heap = true;
            }
        } else {
            let m = JSON.parse(message);
            if (m.message_type == 0) {
                console.log("MESSAGE RECEIVED: ", m);
                call_wasm_unnetworked(m.function_name, m.args, m.time);
            } else if (m.message_type == 1) {
                console.log("BEGINNING HEAP LOAD");
                heap_bytes_remaining = m.heap_size;
                new_heap_offset = 0;
                console.log("HEAP BYTES REMAINING: ", heap_bytes_remaining);

                new_heap = new Uint8Array(m.heap_size);
            } else if (m.message_type == 2) {
                // TODO: This could be an unloaded peer.
                // That should be avoided somehow.
                if (loaded_heap) {
                    room_object.message_specific_peer(peer_id, JSON.stringify({
                        message_type: 1,
                        heap_size: wasm_memory.buffer.byteLength
                    }));

                    console.log("HEAP SIZE: ", wasm_memory.buffer.byteLength);
                    for (let i = 0; i < wasm_memory.buffer.byteLength; i += HEAP_CHUNK_SIZE) {
                        room_object.message_specific_peer(peer_id, new Uint8Array(wasm_memory.buffer).slice(i, Math.min(i + HEAP_CHUNK_SIZE, wasm_memory.buffer.byteLength)));
                    }
                } else {
                    console.error("FATAL ERROR: PEER IS REQUESTING HEAP BUT I DO NOT HAVE IT YET");
                }
            }
        }
    });

    async function call_wasm_unnetworked(function_name, args, time) {
        let i = function_calls.length;
        for (; i > 0; i--) {
            if (function_calls[i - 1].time < time) {
                break;
            }
        }

        // Undo everything that ocurred prior to this event.
        await rewind(time);

        function_calls.splice(i, 0, { function_name: function_name, args: args, time: time });
        current_time = time;
        let result = wasm_instance.exports[function_name](...args);

        // Replay all function calls that occur after this event.
        for (let j = i + 1; j < function_calls.length; j++) {
            console.log("REPLAYING FUNCTION CALL");
            let call = function_calls[j];
            current_time = call.current_time;
            wasm_instance.exports[call.function_name](...call.args)
        }

        current_time = time;
        return result;
    }

    async function rewind(timestamp) {
        while (actions.at(-1) && actions.at(-1).time > timestamp) {
            let popped_action = actions.pop();

            switch (popped_action.type) {
                case "store":
                    console.log("REVERSING STORE");

                    let destination = new Uint8Array(wasm_memory.buffer, popped_action.location, popped_action.old_value.byteLength);
                    destination.set(popped_action.old_value);
                    break;
                case "grow":
                    console.log("REVERSING GROW");
                    // The only way to "shrink" a Wasm instance is to construct an entirely new 
                    // one with a new memory.
                    // Hopefully Wasm gets a better way to shrink modules in the future.

                    let new_memory = new WebAssembly.Memory({
                        initial: popped_action.old_pages
                    });

                    let dest = new Uint8Array(new_memory.buffer);
                    dest.set(wasm_memory.buffer.slice(new_memory.buffer.byteLength));
                    imports_in.mem = new_memory;

                    await WebAssembly.instantiate(wasm_module, imports_in).then(r => {
                        wasm_memory = r.exports.memory;
                        wasm_instance = r;
                    });

                    break;
                case "global_set":
                    console.log("REVERSING GLOBAL SET");

                    wasm_instance.exports[popped_action.global_id] = popped_action.old_value;
                    break;
            }
        }
    }

    return {
        call_wasm_unnetworked: async function (function_name, args, time) {
            return await call_wasm_unnetworked(function_name, args, time);
        },
        call_wasm: async function (function_name, args, time) {

            let actions_len = actions.length;
            let result = await call_wasm_unnetworked(function_name, args, time);

            // Only network this call if it resulted in persistent changes.
            if (actions_len != actions.length) {
                // Network this call
                // TODO: More efficient encoding
                room_object.broadcast(JSON.stringify(({
                    message_type: 0,
                    function_name: function_name,
                    time: time,
                    args: args
                })));
            }

            return result;
        },
        remove_history: function (timestamp) {
            let step = 0;
            for (; step < actions.length; step++) {
                if (actions[step].time >= timestamp) {
                    break;
                }
            }

            // Remove all the elements that were before this.
            actions.splice(step, actions.length);
        }
    };
}