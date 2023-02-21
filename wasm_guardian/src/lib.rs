use walrus::ir::{MemArg, RefNull, StoreKind};

/// Transforms a WebAssembly binary to report to the host environment whenever it makes persistent state changes.
///
/// If memory is modified the imported function `on_store` will be called with an i32 of the
/// address changed and an i32 of the size of the location modified.
///
/// If the WebAssembly grows the memory the imported function `on_grow` will be called with the
/// number of WebAssembly pages to be allocated.
///
/// When a global is set "on_global_set" is called with an i32 that corresponds to an exported global
/// named "wg_global_n" where n is replaced with the i32.
pub fn transform_wasm_to_track_changes(
    bytes: &[u8],
    export_globals: bool,
    track_changes: bool,
) -> Vec<u8> {
    let mut module = walrus::Module::from_buffer(&bytes).unwrap();

    let walrus::Module {
        exports,
        globals,
        tables,
        memories,
        ..
    } = &mut module;

    if export_globals {
        for global in globals.iter() {
            if global.mutable {
                match global.kind {
                    walrus::GlobalKind::Local(walrus::InitExpr::Value(..)) => {
                        exports.add(&format!("wg_global_{:?}", global.id().index()), global.id());
                    }
                    _ => {}
                }
            }
        }
    }

    if track_changes {
        const WASM_PAGE_SIZE: u32 = 2 ^ 16;
        const PAGE_SIZE_POWER_OF_2: u32 = 16;
        const PAGE_SIZE_BYTES: u32 = 2 ^ PAGE_SIZE_POWER_OF_2;

        let initial_memory = memories.iter().next().unwrap();

        /*
        let dirty_flags_table = tables.add_local(
            (initial_memory.initial * WASM_PAGE_SIZE) / PAGE_SIZE_BYTES,
            None,
            walrus::ValType::Funcref,
        );
        */

        //  exports.add("wg_dirty_flags", dirty_flags_table);

        // Create a unique local identifier, one for each type we'll need to temporarily store.
        let local0 = module.locals.add(walrus::ValType::I32);
        let local1_i32 = module.locals.add(walrus::ValType::I32);
        let local1_i64 = module.locals.add(walrus::ValType::I64);
        let local1_i128 = module.locals.add(walrus::ValType::V128);
        let local1_f32 = module.locals.add(walrus::ValType::F32);
        let local1_f64 = module.locals.add(walrus::ValType::F64);

        let wg_dirty_flags = module.globals.add_local(
            walrus::ValType::I32,
            true,
            walrus::InitExpr::Value(walrus::ir::Value::I32(0)),
        );
        module.exports.add("wg_dirty_flags", wg_dirty_flags);

        // Used for 3 arg operations that are part of the bulk-memory extension.
        // let local2 = module.locals.add(walrus::ValType::I32);
        // let local3 = module.locals.add(walrus::ValType::I32);

        let function_type = module.types.add(&[walrus::ValType::I32], &[]);
        let grow_function = module
            .add_import_func("wasm_guardian", "on_grow", function_type)
            .0;
        let global_set_function = module
            .add_import_func("wasm_guardian", "on_global_set", function_type)
            .0;
        let memory = module.memories.iter().next().unwrap().id();

        let mut new_instructions = Vec::new();
        let mut blocks = Vec::new();

        for (i, function) in module.funcs.iter_local_mut() {
            blocks.clear();
            blocks.push(function.entry_block());

            let mut visitor = AllBlocks {
                blocks: &mut blocks,
            };

            walrus::ir::dfs_in_order(&mut visitor, function, function.entry_block());

            for block in &mut blocks {
                let instructions = &mut function.block_mut(*block).instrs;
                new_instructions.clear();
                new_instructions.reserve(instructions.len());

                for instruction in instructions.iter_mut() {
                    match &instruction.0 {
                        // TODO: Handle MemoryCopy
                        walrus::ir::Instr::DataDrop(_)
                        | walrus::ir::Instr::TableInit(_)
                        | walrus::ir::Instr::ElemDrop(_)
                        | walrus::ir::Instr::TableCopy(_)
                        | walrus::ir::Instr::TableGrow(_)
                        | walrus::ir::Instr::TableFill(_) => {
                            todo!("{:?}", instruction.0)
                        }
                        walrus::ir::Instr::MemoryCopy(_)
                        | walrus::ir::Instr::MemoryInit(_)
                        | walrus::ir::Instr::MemoryFill(_) => {
                            new_instructions.push(instruction.clone());

                            // These operations probably require looping to set the pages that were written to.
                            // todo!("{:?}", instruction.0)
                        }
                        walrus::ir::Instr::Store(s) => {
                            // 9-11 extra instructions per call to store. Certainly not ideal!

                            // A future optimization that could be made here is to move the code that creates the second store
                            // arg to after this store tracking code.
                            // That would save an additional 2 instructions.

                            let local1 = match s.kind {
                                walrus::ir::StoreKind::I32 { .. } => local1_i32,
                                walrus::ir::StoreKind::I64 { .. } => local1_i64,
                                walrus::ir::StoreKind::F32 => local1_f32,
                                walrus::ir::StoreKind::F64 => local1_f64,
                                walrus::ir::StoreKind::V128 => local1_i128,
                                walrus::ir::StoreKind::I32_8 { .. } => local1_i32,
                                walrus::ir::StoreKind::I32_16 { .. } => local1_i32,
                                walrus::ir::StoreKind::I64_8 { .. } => local1_i64,
                                walrus::ir::StoreKind::I64_16 { .. } => local1_i64,
                                walrus::ir::StoreKind::I64_32 { .. } => local1_i64,
                            };

                            // Push both store args to temporary locals.
                            // This isn't the most efficient approach but it is simple
                            // and works for now without more complex analysis.
                            new_instructions.extend_from_slice(&[
                                (
                                    walrus::ir::Instr::LocalSet(walrus::ir::LocalSet {
                                        local: local1,
                                    }),
                                    walrus::InstrLocId::default(),
                                ),
                                (
                                    walrus::ir::Instr::LocalTee(walrus::ir::LocalTee {
                                        local: local0,
                                    }),
                                    walrus::InstrLocId::default(),
                                ),
                            ]);

                            // If there is an offset then add it to the address.
                            if s.arg.offset != 0 {
                                new_instructions.extend_from_slice(&[
                                    (
                                        walrus::ir::Instr::Const(walrus::ir::Const {
                                            value: walrus::ir::Value::I32(s.arg.offset as _),
                                        }),
                                        walrus::InstrLocId::default(),
                                    ),
                                    (
                                        // This is operating on memory addresses, is this the correct type of add?
                                        walrus::ir::Instr::Binop(walrus::ir::Binop {
                                            op: walrus::ir::BinaryOp::I32Add,
                                        }),
                                        walrus::InstrLocId::default(),
                                    ),
                                ]);
                            }
                            new_instructions.extend_from_slice(&[
                                // Mark dirty_flags for the start of the value being stored.
                                (
                                    walrus::ir::Instr::Const(walrus::ir::Const {
                                        value: walrus::ir::Value::I32(PAGE_SIZE_POWER_OF_2 as _),
                                    }),
                                    walrus::InstrLocId::default(),
                                ),
                                (
                                    walrus::ir::Instr::Binop(walrus::ir::Binop {
                                        op: walrus::ir::BinaryOp::I32ShrU,
                                    }),
                                    walrus::InstrLocId::default(),
                                ),
                                (
                                    walrus::ir::Instr::GlobalGet(walrus::ir::GlobalGet {
                                        global: wg_dirty_flags,
                                    }),
                                    walrus::InstrLocId::default(),
                                ),
                                (
                                    walrus::ir::Instr::Binop(walrus::ir::Binop {
                                        op: walrus::ir::BinaryOp::I32Add,
                                    }),
                                    walrus::InstrLocId::default(),
                                ),
                                (
                                    walrus::ir::Instr::Const(walrus::ir::Const {
                                        value: walrus::ir::Value::I32(1),
                                    }),
                                    walrus::InstrLocId::default(),
                                ),
                                (
                                    walrus::ir::Instr::Store(walrus::ir::Store {
                                        memory,
                                        kind: StoreKind::I32 { atomic: false },
                                        arg: MemArg {
                                            align: 4,
                                            offset: 0,
                                        },
                                    }),
                                    walrus::InstrLocId::default(),
                                ),
                                /*
                                (
                                    walrus::ir::Instr::RefNull(RefNull {
                                        ty: walrus::ValType::Funcref,
                                    }),
                                    walrus::InstrLocId::default(),
                                ),
                                (
                                    walrus::ir::Instr::TableSet(walrus::ir::TableSet {
                                        table: dirty_flags_table,
                                    }),
                                    walrus::InstrLocId::default(),
                                ),
                                */
                            ]);

                            // Note: This store could overlap the next page. It's up to the host environment to check
                            // the start of pages following dirty pages.

                            new_instructions.extend_from_slice(&[
                                // Restore the locals so the store OP can go ahead.
                                (
                                    walrus::ir::Instr::LocalGet(walrus::ir::LocalGet {
                                        local: local0,
                                    }),
                                    walrus::InstrLocId::default(),
                                ),
                                (
                                    walrus::ir::Instr::LocalGet(walrus::ir::LocalGet {
                                        local: local1,
                                    }),
                                    walrus::InstrLocId::default(),
                                ),
                                instruction.clone(),
                            ]);
                        }
                        walrus::ir::Instr::MemoryGrow { .. } => {
                            // Report memory grows
                            new_instructions.extend_from_slice(&[
                                (
                                    walrus::ir::Instr::LocalTee(walrus::ir::LocalTee {
                                        local: local0,
                                    }),
                                    walrus::InstrLocId::default(),
                                ),
                                (
                                    walrus::ir::Instr::Call(walrus::ir::Call {
                                        func: grow_function,
                                    }),
                                    walrus::InstrLocId::default(),
                                ),
                                (
                                    walrus::ir::Instr::LocalGet(walrus::ir::LocalGet {
                                        local: local0,
                                    }),
                                    walrus::InstrLocId::default(),
                                ),
                                instruction.clone(),
                            ]);
                        }
                        // Globals can be set frequently but usually there aren't that many of them.
                        // It's generally quicker to just skim them from the host environment to check for changes.
                        /*
                        walrus::ir::Instr::GlobalSet(global_set) => {
                            new_instructions.extend_from_slice(&[
                                (
                                    walrus::ir::Instr::Const(walrus::ir::Const {
                                        value: walrus::ir::Value::I32(
                                            global_set.global.index() as i32
                                        ),
                                    }),
                                    walrus::InstrLocId::default(),
                                ),
                                (
                                    walrus::ir::Instr::Call(walrus::ir::Call {
                                        func: global_set_function,
                                    }),
                                    walrus::InstrLocId::default(),
                                ),
                                instruction.clone(),
                            ]);
                        }*/
                        _ => {
                            new_instructions.push(instruction.clone());
                        }
                    }
                }
                std::mem::swap(&mut new_instructions, instructions);
            }
        }
    }

    module.emit_wasm()
}

struct AllBlocks<'a> {
    blocks: &'a mut Vec<walrus::ir::InstrSeqId>,
}

impl<'instr> walrus::ir::Visitor<'instr> for AllBlocks<'instr> {
    fn visit_block(&mut self, instr: &walrus::ir::Block) {
        self.blocks.push(instr.seq);
    }
    fn visit_loop(&mut self, instr: &walrus::ir::Loop) {
        self.blocks.push(instr.seq);
    }
    fn visit_if_else(&mut self, instr: &walrus::ir::IfElse) {
        self.blocks.push(instr.consequent);
        self.blocks.push(instr.alternative);
    }
}

#[test]
fn test() {
    let bytes =
        std::fs::read("/Users/ian/Workspace/tangle/examples/ball_pit/dist/my_wasm.wasm").unwrap();
    let output = transform_wasm_to_track_changes(&bytes, true, true);
    std::fs::write("output.wasm", &output).unwrap();
}
