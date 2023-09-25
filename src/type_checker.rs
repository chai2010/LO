use crate::{ast::*, ir::*, wasm::*};
use alloc::{vec, vec::Vec};

pub fn get_types(
    ctx: &BlockContext,
    instrs: &Vec<WasmInstr>,
) -> Result<Vec<WasmType>, CompileError> {
    let mut types = vec![];
    for instr in instrs {
        types.append(&mut get_type(ctx, instr)?);
    }
    Ok(types)
}

pub fn get_type(ctx: &BlockContext, instr: &WasmInstr) -> Result<Vec<WasmType>, CompileError> {
    Ok(match instr {
        WasmInstr::Unreachable { .. } => vec![],
        WasmInstr::I32ConstLazy { .. } => vec![WasmType::I32],
        WasmInstr::I32Const { .. } => vec![WasmType::I32],
        WasmInstr::I64Const { .. } => vec![WasmType::I64],
        WasmInstr::MultiValueEmit { values, .. } => get_types(ctx, values)?,
        WasmInstr::StructLoad {
            primitive_loads, ..
        } => get_types(ctx, primitive_loads)?,
        WasmInstr::StructGet { primitive_gets, .. } => get_types(ctx, primitive_gets)?,
        WasmInstr::NoEmit { instr } => get_type(ctx, instr)?,

        // type-checked in the complier:
        WasmInstr::NoTypeCheck { .. } => vec![],
        WasmInstr::Set { .. } => vec![],
        WasmInstr::Drop { .. } => vec![],
        WasmInstr::Return { .. } => vec![],
        WasmInstr::MemorySize { .. } => vec![WasmType::I32],
        WasmInstr::MemoryGrow { .. } => vec![WasmType::I32],

        WasmInstr::BinaryOp { lhs, rhs, .. } => {
            get_type(ctx, rhs)?;
            return get_type(ctx, lhs);
        }
        WasmInstr::Load {
            kind,
            address_instr,
            ..
        } => {
            get_type(ctx, &address_instr)?;
            // TODO: use primitive type
            vec![kind.get_primitive_type().to_wasm_type()]
        }
        WasmInstr::GlobalGet { global_index, .. } => {
            let wasm_global = ctx
                .module
                .wasm_module
                .globals
                .get(*global_index as usize)
                .ok_or_else(|| CompileError::unreachable(file!(), line!()))?;

            vec![wasm_global.kind.value_type]
        }
        WasmInstr::LocalGet { local_index, .. } => {
            let local_index = *local_index as usize;
            let locals_len = ctx.fn_ctx.fn_type.inputs.len();
            if local_index < locals_len {
                vec![ctx.fn_ctx.fn_type.inputs[local_index]]
            } else {
                vec![ctx.fn_ctx.non_arg_locals[local_index - locals_len]]
            }
        }
        WasmInstr::Call { fn_type_index, .. } => {
            let fn_type = &ctx.module.wasm_module.types[*fn_type_index as usize];
            fn_type.outputs.clone()
        }
        WasmInstr::If { block_type, .. }
        | WasmInstr::Block { block_type, .. }
        | WasmInstr::Loop { block_type, .. } => {
            if let Some(block_type) = block_type {
                vec![*block_type]
            } else {
                vec![]
            }
        }
        WasmInstr::Branch { .. } => vec![],
    })
}
