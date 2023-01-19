export interface RoomConfiguration {
    name?: string
    server_url?: string
    on_state_change?: (room_state: RoomState) => void;
    on_peer_disconnected?: (peer_id: string) => void;
    on_message?: (peer_id: string, message: any) => void;
}

export enum RoomState {
    Joining,
    Connected,
    Disconnected
}

class Peer {
    constructor(public connection: RTCPeerConnection, public data_channel: RTCDataChannel) { }
}

export class Room {
    private __peers_to_join: Set<string> = new Set();
    private _current_state: RoomState = RoomState.Disconnected;
    private _peers: Map<string, Peer> = new Map();
    private _configuration: RoomConfiguration = {};

    static async setup(_configuration: RoomConfiguration): Promise<Room> {
        let room = new Room();
        await room._setup_inner(_configuration);
        return room;
    }

    broadcast(data: string | Blob | ArrayBuffer | ArrayBufferView) {
        // TODO: Fragment data if too large
        for (let [_, peer] of this._peers) {
            // TODO: Figure out if there's a better way to call this without the
            // 'as any'
            peer.data_channel.send(data as any);
        }
    }

    message_specific_peer(peer_id: string, data: string | Blob | ArrayBuffer | ArrayBufferView) {
        // TODO: Fragment data if too large

        // TODO: Figure out if there's a better way to call this without the
        // 'as any'
        this._peers.get(peer_id)?.data_channel.send(data as any);
    }

    get_lowest_latency_peer(): string | undefined {
        // TODO: Implement this.
        return undefined;
    }

    private async _setup_inner(room__configuration: RoomConfiguration) {
        this._configuration = room__configuration;
        this._configuration.name ??= "";
        this._configuration.server_url ??= "0.0.0.0:8081";

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
                this.__peers_to_join = new Set(message._peers);

                this._configuration.on_state_change?.(this._current_state);

                // If we've already connected to a peer then remove it from the _peers to join.
                for (const [key, value] of this._peers) {
                    this.__peers_to_join.delete(key);
                }
                this.check_if_joined();
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
                this.__peers_to_join.delete(message.disconnected_peer_id);
                this.check_if_joined();
            }
        };

        server_socket.onclose = (event) => {
            // Disconnecting from the WebSocket is considered a full disconnect from the room.

            // TODO: On disconnected callback
            this._current_state = RoomState.Disconnected;
            this.__peers_to_join.clear();
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
        if (this._current_state == RoomState.Joining && this.__peers_to_join.size == 0) {
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

        data_channel.onopen = event => {
            peer_connection.getStats(null).then((stats) => {
                console.log("[room] DataChannel stats: ");
                console.log(stats);
                stats.forEach((report) => {
                    if (report.type === "candidate-pair") {
                        console.log("[room] Round trip seconds to _peers: %s : %s", peer_id, report.currentRoundTripTime);
                    }
                });
                this.__peers_to_join.delete(peer_id);

                // TODO: Call peer joined callback.
                // on_peer_joined(peer_id, welcoming);
                this.check_if_joined();
            });
        }

        data_channel.onmessage = (event) => {
            // Call the user provided callback
            this._configuration.on_message?.(event.data, peer_id);
        }

        this._peers.set(peer_id, new Peer(peer_connection, data_channel));
        return peer_connection;
    }

    private remove_peer(peer_id: string) {
        let peer = this._peers.get(peer_id);

        if (peer) {
            peer.connection.close();
            this._peers.delete(peer_id);
            this._configuration.on_peer_disconnected?.(peer_id);
        }
    }
}

