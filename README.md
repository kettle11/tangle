# TangleSync

[Play with a live demo](tanglesync.com)

TangleSync is a library that aims to make multiplayer apps and games far easier to build. 

TangleSync 'magically' wraps WebAssembly so you can write programs without worrying about message passing, serialization, or consensus. 

## WARNING

This library is incredibly new. It has many bugs, TODOs, and known issues. Give it a try, be patient, and consider contributing!

## Questions

### What is this for?

Right now TangleSync is great for small games and apps. In the future it may be useful for all sorts of things including (but not limited to): yncing programs between servers / clients, untrusted plugins in networked software, 'metaverse'-like scripting, and backend-less collaborative software.

### How is this hosted?

Connections are peer to peer but the initial connection needs to be facilitated by a central server. Right now I run a free instance of that server but if it gets serious traffic I may offer a paid version.

### How does it work?

TangleSync syncs initial state and networks all subsequent inputs that could cause simulations to diverge. TangleSync keeps every bit identical between all connected Wasm instances. 
'Snapshots' are taken at each simulation step to enable 'rewinding' and 'replaying' events to ensure all peers apply events in the same order, without adding latency to user input.

TODO: Write a more detailed explainer.

### What are its limitations?

Due to how rollback works frequently updated programs will have increased input latency if they do not keep CPU and memory usage low. This is an area that will see future improvement.

TangleSync does nothing to merge long stretches of offline editing. It is not a CRDT.

### What languages does this support?

In theory: Any language that targets WebAssembly. In practice I've only tested [AssemblyScript](https://www.assemblyscript.org) and [Rust](https://www.rust-lang.org).

### Is this web only?

Right now TangleSync is implemented as a TypeScript library for web but its fundamental architecture *could* be made to work on native platforms eventually.
