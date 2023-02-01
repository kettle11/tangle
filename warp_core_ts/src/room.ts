export interface RoomConfiguration {
    name?: string
    server_url?: string
    on_state_change?: (room_state: RoomState) => void;
    on_peer_joined?: (peer_id: string) => void;
    on_peer_left?: (peer_id: string) => void;
    on_message?: (peer_id: string, message: Uint8Array) => void;
}

export enum RoomState {
    Joining,
    Connected,
    Disconnected
}

type Peer = {
    id: string,
    connection: RTCPeerConnection,
    data_channel: RTCDataChannel,
    ready: boolean,
    latest_message_data: Uint8Array
    latest_message_offset: number,
}

enum MessageType {
    MultiPartStart = 1,
    MultiPartContinuation = 2,
    SinglePart = 3,
}

const MAX_MESSAGE_SIZE = 16_000;

export class Room {
    private _peers_to_join: Set<string> = new Set();
    private _current_state: RoomState = RoomState.Disconnected;
    private _peers: Map<string, Peer> = new Map();
    private _configuration: RoomConfiguration = {};
    private _current_room_name: String = "";
    private outgoing_data_chunk = new Uint8Array(MAX_MESSAGE_SIZE + 5);
    private _artificial_delay = 60;

    static async setup(_configuration: RoomConfiguration): Promise<Room> {
        let room = new Room();
        await room._setup_inner(_configuration);
        return room;
    }

    private message_peer_inner(peer: Peer, data: Uint8Array) {
        // TODO: Verify this
        // If the message is too large fragment it. 
        // TODO: If there's not space in the outgoing channel push messages to an outgoing buffer.

        let total_length = data.byteLength;

        if (total_length > MAX_MESSAGE_SIZE) {
            this.outgoing_data_chunk[0] = MessageType.MultiPartStart;
            new DataView(this.outgoing_data_chunk.buffer).setUint32(1, total_length);

            this.outgoing_data_chunk.set(data.subarray(0, MAX_MESSAGE_SIZE), 5);
            peer.data_channel.send(this.outgoing_data_chunk);

            let data_offset = data.subarray(MAX_MESSAGE_SIZE);

            while (data_offset.byteLength > 0) {
                length = Math.min(data_offset.byteLength, MAX_MESSAGE_SIZE);
                this.outgoing_data_chunk[0] = MessageType.MultiPartContinuation;
                this.outgoing_data_chunk.set(data_offset.subarray(0, length), 1);
                data_offset = data_offset.subarray(length);
                peer.data_channel.send(this.outgoing_data_chunk.subarray(0, length + 1));
            }
        } else {
            this.outgoing_data_chunk[0] = MessageType.SinglePart;
            this.outgoing_data_chunk.set(data, 1);
            peer.data_channel.send(this.outgoing_data_chunk.subarray(0, data.byteLength + 1));
        }

    }

    send_message(data: Uint8Array, peer_id?: string) {
        if (peer_id) {
            let peer = this._peers.get(peer_id)!;
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

    get_lowest_latency_peer(): string | undefined {
        // TODO: Implement this.
        return this._peers.entries().next().value?.[0];
    }

    private async _setup_inner(room__configuration: RoomConfiguration) {
        onhashchange = (event) => {
            if (this._current_room_name != document.location.hash.substring(1)) {
                location.reload();
                this._current_room_name = document.location.hash.substring(1);
            }
        };

        this._configuration = room__configuration;
        this._configuration.name ??= "";
        this._configuration.server_url ??= "192.168.68.109:8081";

        const server_socket = new WebSocket("ws://" + this._configuration.server_url);
        server_socket.onopen = () => {
            console.log("[room] Connection established with server");
            console.log("[room] Requesting to join room: ", this._configuration.name);
            server_socket.send(JSON.stringify({ 'join_room': document.location.hash.substring(1) }));
        };

        server_socket.onmessage = async (event) => {
            const last_index = event.data.lastIndexOf('}');
            const json = event.data.substring(0, last_index + 1);

            const message = JSON.parse(json);
            // peer_id is appended by the server to the end of incoming messages.
            const peer_id = event.data.substring(last_index + 1).trim();

            if (message.room_name) {
                // Received when joining a room for the first time.
                console.log("[room] Entering room: ", message.room_name);

                this._current_state = RoomState.Joining;
                this._peers_to_join = new Set(message.peers);

                this._configuration.on_state_change?.(this._current_state);

                // If we've already connected to a peer then remove it from the _peers to join.
                for (const [key, value] of this._peers) {
                    this._peers_to_join.delete(key);
                }
                this.check_if_joined();

                // TODO: Make this messing with the URL an optional thing.
                document.location =
                    document.location.origin.toString() +
                    '#' + message.room_name;
                this._current_room_name = message.room_name;
            } else if (message.join_room) {
                console.log("[room] Peer joining room: ", peer_id);
                this.make_rtc_peer_connection(peer_id, server_socket);
            } else if (message.offer) {
                let peer_connection = this.make_rtc_peer_connection(peer_id, server_socket);
                await peer_connection.setRemoteDescription(new RTCSessionDescription(message.offer));
                const answer = await peer_connection.createAnswer();
                await peer_connection.setLocalDescription(answer);
                server_socket.send(JSON.stringify({ 'answer': answer, 'destination': peer_id }));
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
                console.log("[room] Peer left: ", message.disconnected_peer_id);
                this.remove_peer(message.disconnected_peer_id);
                this._peers_to_join.delete(message.disconnected_peer_id);
                this.check_if_joined();
            }
        };

        server_socket.onclose = (event) => {
            // Disconnecting from the WebSocket is considered a full disconnect from the room.

            // TODO: On disconnected callback
            this._current_state = RoomState.Disconnected;
            this._peers_to_join.clear();
            this._peers.clear();

            if (event.wasClean) {
                console.log(`[room] Server connection closed cleanly, code=${event.code} reason=${event.reason}`);
            } else {
                console.log('[room] Connection died');
            }

            this._configuration.on_state_change?.(this._current_state);
        };

        server_socket.onerror = function (error) {
            console.log(`[room] Server socket error ${error}`);
        };
    }

    private check_if_joined() {
        if (this._current_state == RoomState.Joining && this._peers_to_join.size == 0) {
            this._current_state = RoomState.Connected;
            this._configuration.on_state_change?.(this._current_state);
        }
    }

    private make_rtc_peer_connection(peer_id: string, server_socket: WebSocket): RTCPeerConnection {
        const ICE_SERVERS = [
            { urls: "stun:stun1.l.google.com:19302" },
        ];
        const peer_connection = new RTCPeerConnection({ 'iceServers': ICE_SERVERS });

        // TODO: If this is swapped to a more unreliable UDP-like protocol then ordered and maxRetransmits should be set to false and 0.
        //
        // maxRetransmits: null is meant to be the default but explicitly setting it seems to trigger a Chrome
        // bug where some packets are dropped.
        // TODO: Report this bug.
        const data_channel = peer_connection.createDataChannel("sendChannel", { negotiated: true, id: 2, ordered: true });
        data_channel.binaryType = "arraybuffer";

        peer_connection.onicecandidate = event => {
            console.log("[room] New ice candidate: ", event.candidate);
            if (event.candidate) {
                console.log(JSON.stringify({ 'new_ice_candidate': event.candidate, 'destination': peer_id }));
                server_socket.send(JSON.stringify({ 'new_ice_candidate': event.candidate, 'destination': peer_id }));
            }
        };

        peer_connection.onicecandidateerror = event => {
            console.log("[room] Ice candidate error: ", event);
        };

        peer_connection.onnegotiationneeded = async (event) => {
            console.log("[room] Negotiation needed");
            const offer = await peer_connection.createOffer();
            await peer_connection.setLocalDescription(offer);
            server_socket.send(JSON.stringify({ 'offer': offer, 'destination': peer_id }));
        };

        peer_connection.onsignalingstatechange = (event) => {
            console.log("[room] Signaling state changed: ", peer_connection.signalingState)
        };

        peer_connection.onconnectionstatechange = (event) => {
            console.log("[room] Connection state changed: ", peer_connection.connectionState)
        };

        peer_connection.ondatachannel = (event) => {
            let data_channel = event.channel;

        };

        data_channel.onopen = event => {
            this._peers_to_join.delete(peer_id);

            this._peers.get(peer_id)!.ready = true;
            this._configuration.on_peer_joined?.(peer_id);
            this.check_if_joined();

            /*
            peer_connection.getStats().then((stats) => {

                console.log("[room] DataChannel stats: ");
                console.log(stats);
                stats.forEach((report) => {
                    //  console.log("REPORT: %s ", report.type, report);
                    if (report.type === "candidate-pair") {
                        console.log("[room] Round trip seconds to _peers: %s : %s", peer_id, report.currentRoundTripTime);
                    }
                });

                this._peers_to_join.delete(peer_id);

                this._peers.get(peer_id)!.ready = true;
                this._configuration.on_peer_joined?.(peer_id);
                this.check_if_joined();
            });
            */
        }

        data_channel.onmessage = (event) => {
            // First check that this peer hasn't been officially disconnected.
            if (this._peers.get(peer_id)) {
                if (event.data.byteLength > 0) {
                    // Defragment the message
                    let message_data = new Uint8Array(event.data);
                    switch (message_data[0]) {
                        case MessageType.SinglePart: {
                            // Call the user provided callback
                            setTimeout(() => {
                                this._configuration.on_message?.(peer_id, message_data.subarray(1));
                            }, this._artificial_delay);
                            break;
                        }
                        case MessageType.MultiPartStart: {
                            let data = new DataView(message_data.buffer, 1);
                            let length = data.getUint32(0);

                            let peer = this._peers.get(peer_id)!;
                            peer.latest_message_data = new Uint8Array(length);
                            this.multipart_data_received(peer, message_data.subarray(5));
                            break;
                        }
                        case MessageType.MultiPartContinuation: {
                            let peer = this._peers.get(peer_id)!;
                            this.multipart_data_received(peer, message_data.subarray(1));
                        }
                    }
                }
            } else {
                console.error("DISCARDING MESSAGE FROM PEER: ", event.data);
            }
        }

        this._peers.set(peer_id, { id: peer_id, connection: peer_connection, data_channel, ready: false, latest_message_data: new Uint8Array(0), latest_message_offset: 0 });
        return peer_connection;
    }

    private multipart_data_received(peer: Peer, data: Uint8Array) {
        peer.latest_message_data.set(data, peer.latest_message_offset);
        peer.latest_message_offset += data.byteLength;

        if (peer.latest_message_offset == peer.latest_message_data.length) {
            let data = peer.latest_message_data;

            // TODO: This introduces a potential one-frame delay on incoming events.
            // Message received
            setTimeout(() => {
                this._configuration.on_message?.(peer.id, data);
            }, this._artificial_delay);
            peer.latest_message_offset = 0;
            peer.latest_message_data = new Uint8Array(0);
        }
    }

    private remove_peer(peer_id: string) {
        let peer = this._peers.get(peer_id);

        if (peer) {
            peer.connection.close();
            this._peers.delete(peer_id);
            this._configuration.on_peer_left?.(peer_id);
        }
    }
}

