use walrus::ir::RefNull;

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

        let dirty_flags_table = tables.add_local(
            (initial_memory.initial * WASM_PAGE_SIZE) / PAGE_SIZE_BYTES,
            None,
            walrus::ValType::Funcref,
        );

        // Create a unique local identifier, one for each type we'll need to temporarily store.
        let local0 = module.locals.add(walrus::ValType::I32);
        let local1_i32 = module.locals.add(walrus::ValType::I32);
        let local1_i64 = module.locals.add(walrus::ValType::I64);
        let local1_i128 = module.locals.add(walrus::ValType::V128);
        let local1_f32 = module.locals.add(walrus::ValType::F32);
        let local1_f64 = module.locals.add(walrus::ValType::F64);

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

        let mut new_instructions = Vec::new();
        let mut blocks = Vec::new();

        for (_, function) in module.funcs.iter_local_mut() {
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
                            // These operations probably require looping to set the pages that were written to.
                            todo!()
                        }
                        walrus::ir::Instr::Store(s) => {
                            // 15-19 extra instructions per call to store. Certainly not ideal!

                            let (local1, size) = match s.kind {
                                walrus::ir::StoreKind::I32 { .. } => {
                                    (local1_i32, std::mem::size_of::<i32>() as _)
                                }
                                walrus::ir::StoreKind::I64 { .. } => {
                                    (local1_i64, std::mem::size_of::<i64>() as _)
                                }
                                walrus::ir::StoreKind::F32 => {
                                    (local1_f32, std::mem::size_of::<f32>() as _)
                                }
                                walrus::ir::StoreKind::F64 => {
                                    (local1_f64, std::mem::size_of::<f64>() as _)
                                }
                                walrus::ir::StoreKind::V128 => {
                                    (local1_i128, std::mem::size_of::<i128>() as _)
                                }
                                walrus::ir::StoreKind::I32_8 { .. } => {
                                    (local1_i32, std::mem::size_of::<i32>() as _)
                                }
                                walrus::ir::StoreKind::I32_16 { .. } => {
                                    (local1_i32, std::mem::size_of::<i32>() as _)
                                }
                                walrus::ir::StoreKind::I64_8 { .. } => {
                                    (local1_i64, std::mem::size_of::<i64>() as _)
                                }
                                walrus::ir::StoreKind::I64_16 { .. } => {
                                    (local1_i64, std::mem::size_of::<i64>() as _)
                                }
                                walrus::ir::StoreKind::I64_32 { .. } => {
                                    (local1_i64, std::mem::size_of::<i64>() as _)
                                }
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
                                // Mark dirty flags for the end of the value being stored.
                                // It's unfortunate this is needed because it's non-trivial overhead.
                                (
                                    walrus::ir::Instr::LocalGet(walrus::ir::LocalGet {
                                        local: local0,
                                    }),
                                    walrus::InstrLocId::default(),
                                ),
                                (
                                    walrus::ir::Instr::Const(walrus::ir::Const {
                                        value: walrus::ir::Value::I32(size),
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
                        }
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
}

/*
#[test]
fn test() {
    let bytes = std::fs::read("wasm_snippets/example_script_bulk_memory.wasm").unwrap();
    let output = transform_wasm_to_track_changes(&bytes);
    std::fs::write("output.wasm", &output).unwrap();
}
*/
