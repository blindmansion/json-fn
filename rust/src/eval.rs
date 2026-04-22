use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{Map, Value};

use crate::error::EvalError;
use crate::path::{ParsedPath, Segment, parse_path, validate_param_name, walk_path};
use crate::value::{
    BodyMeta, FnEntry, FunctionRegistry, expr_error, is_fn_declaration, is_truthy, to_f64,
    type_name,
};

const DEFAULT_MAX_CALL_DEPTH: usize = 256;

/// Caller-supplied evaluation limits.
#[derive(Default, Clone)]
pub struct ExecutionLimits {
    pub max_call_depth: Option<usize>,
    pub max_operations: Option<usize>,
    pub cancel: Option<Arc<AtomicBool>>,
}

#[derive(Clone)]
struct ResolvedLimits {
    max_call_depth: usize,
    max_operations: usize,
    cancel: Option<Arc<AtomicBool>>,
}

#[derive(Default)]
struct CallState {
    depth: usize,
    operations: usize,
}

/// One frame on the variable scope chain. Shared by `Rc` so that nested
/// evaluations and closures can hold references without lifetime gymnastics.
pub(crate) struct Frame {
    /// Body of the function that owns this frame. Held as `Arc<BodyMeta>` so
    /// the frame can be passed around with zero deep-clones. Reuses the
    /// same `Arc` that the function registry stores, when called by name.
    body: Arc<BodyMeta>,
    evaluated_vars: RefCell<Map<String, Value>>,
    resolving: RefCell<Vec<String>>,
    functions: Arc<FunctionRegistry>,
    parent: Option<Rc<Frame>>,
}

/// The evaluator state. Builtins receive a `&mut EvalCtx` so they can
/// re-enter the interpreter (used by `map`, `reduce`, `pipe`, ...).
pub struct EvalCtx {
    base_functions: Arc<FunctionRegistry>,
    frame: Option<Rc<Frame>>,
    limits: ResolvedLimits,
    state: CallState,
}

/// A function call target that has already been resolved to either a name
/// or a parsed function body. Returned by [`EvalCtx::prepare`]. Reusing one
/// of these in a loop (e.g. inside `map`/`reduce`) avoids re-parsing the
/// body on every iteration.
#[derive(Clone)]
pub enum PreparedCall {
    /// A function looked up by name in the registry.
    Named(String),
    /// An inline function body, pre-wrapped so calls are O(1) cloneable.
    Body(Arc<BodyMeta>),
}

impl EvalCtx {
    fn current_functions(&self) -> Arc<FunctionRegistry> {
        match &self.frame {
            Some(f) => f.functions.clone(),
            None => self.base_functions.clone(),
        }
    }

    /// Public entry point used by builtins. Mirrors the `call` callback that
    /// `BuiltinFunc` receives in the Go and TS implementations.
    pub fn call(&mut self, fn_decl: &Value, args: &[Value]) -> Result<Value, EvalError> {
        call_function_internal(fn_decl, args, self)
    }

    /// Resolve a function declaration value into a [`PreparedCall`] that can
    /// be invoked many times (via [`EvalCtx::call_prepared`]) without
    /// re-parsing the body on each call. Builtins like `map`/`reduce` use
    /// this to avoid repeated `BodyMeta::new` work in their hot loops.
    pub fn prepare(&self, fn_decl: &Value) -> Result<PreparedCall, EvalError> {
        match fn_decl {
            Value::String(name) => Ok(PreparedCall::Named(name.clone())),
            Value::Object(obj) if obj.contains_key("$return") => {
                Ok(PreparedCall::Body(Arc::new(BodyMeta::new(fn_decl.clone()))))
            }
            other => Err(EvalError(format!(
                "cannot call non-function value of type {}",
                type_name(other)
            ))),
        }
    }

    /// Invoke a previously prepared call target. Honors the same depth /
    /// operations limits as [`EvalCtx::call`].
    pub fn call_prepared(
        &mut self,
        target: &PreparedCall,
        args: &[Value],
    ) -> Result<Value, EvalError> {
        self.state.depth += 1;
        let result = (|| {
            if self.state.depth > self.limits.max_call_depth {
                return Err(EvalError(format!(
                    "Maximum call depth of {} exceeded",
                    self.limits.max_call_depth
                )));
            }
            match target {
                PreparedCall::Named(name) => {
                    let registry = self.current_functions();
                    let entry = registry
                        .get(name.as_str())
                        .ok_or_else(|| EvalError(format!("Function {name} not found")))?;
                    if let FnEntry::Pure { f, .. } = entry {
                        return f(args).map_err(|e| {
                            EvalError(format!("Error calling external function {name}: {e}"))
                        });
                    }
                    let entry = entry.clone();
                    drop(registry);
                    match entry {
                        FnEntry::Pure { .. } => unreachable!(),
                        FnEntry::Builtin { f, .. } => f(args, self),
                        FnEntry::Body(meta) => call_json_function_meta(meta, args, self),
                    }
                }
                PreparedCall::Body(meta) => call_json_function_meta(meta.clone(), args, self),
            }
        })();
        self.state.depth -= 1;
        result
    }

    /// Read-only access to the current scope's function registry.
    pub fn functions(&self) -> Arc<FunctionRegistry> {
        self.current_functions()
    }
}

/// Main entry point. `fn_decl` is either a function name (`Value::String`) or
/// a JSON function body (an object containing `$return`).
pub fn call_function(
    fn_decl: &Value,
    args: &[Value],
    functions: &FunctionRegistry,
    limits: Option<&ExecutionLimits>,
) -> Result<Value, EvalError> {
    let resolved = ResolvedLimits {
        max_call_depth: limits
            .and_then(|l| l.max_call_depth)
            .filter(|n| *n > 0)
            .unwrap_or(DEFAULT_MAX_CALL_DEPTH),
        max_operations: limits.and_then(|l| l.max_operations).filter(|n| *n > 0).unwrap_or(0),
        cancel: limits.and_then(|l| l.cancel.clone()),
    };

    let mut ctx = EvalCtx {
        base_functions: Arc::new(functions.clone()),
        frame: None,
        limits: resolved,
        state: CallState::default(),
    };

    call_function_internal(fn_decl, args, &mut ctx)
}

fn call_function_internal(
    fn_decl: &Value,
    args: &[Value],
    ctx: &mut EvalCtx,
) -> Result<Value, EvalError> {
    ctx.state.depth += 1;
    let result = (|| {
        if ctx.state.depth > ctx.limits.max_call_depth {
            return Err(EvalError(format!(
                "Maximum call depth of {} exceeded",
                ctx.limits.max_call_depth
            )));
        }

        match fn_decl {
            Value::String(name) => {
                let registry = ctx.current_functions();
                let entry = registry.get(name.as_str()).ok_or_else(|| {
                    EvalError(format!("Function {name} not found"))
                })?;
                // Pure: f doesn't re-enter the interpreter, so we can call it
                // directly without cloning the entry or dropping the registry
                // borrow. Saves two atomic ops per Pure call (i.e. every call
                // to add/sub/mul/eq/... in arithmetic-heavy code).
                if let FnEntry::Pure { f, .. } = entry {
                    return f(args).map_err(|e| {
                        EvalError(format!("Error calling external function {name}: {e}"))
                    });
                }
                let entry = entry.clone();
                drop(registry);
                match entry {
                    FnEntry::Pure { .. } => unreachable!(),
                    FnEntry::Builtin { f, .. } => f(args, ctx),
                    FnEntry::Body(meta) => call_json_function_meta(meta, args, ctx),
                }
            }
            Value::Object(obj) if obj.contains_key("$return") => {
                // Anonymous function-body call (no entry in the registry).
                // We pay one BodyMeta::new scan but still avoid cloning the
                // body for the recursive frame thanks to Rc.
                let meta = Arc::new(BodyMeta::new(fn_decl.clone()));
                call_json_function_meta(meta, args, ctx)
            }
            other => Err(EvalError(format!(
                "cannot call non-function value of type {}",
                type_name(other)
            ))),
        }
    })();
    ctx.state.depth -= 1;
    result
}

fn call_json_function_meta(
    meta: Arc<BodyMeta>,
    args: &[Value],
    ctx: &mut EvalCtx,
) -> Result<Value, EvalError> {
    let body_obj = meta
        .body
        .as_object()
        .expect("call_json_function: body must be object");

    // Build the per-frame function registry. Only allocate a new one when
    // there are local function declarations; otherwise share the parent's.
    let frame_functions: Arc<FunctionRegistry> = if meta.local_fn_keys.is_empty() {
        ctx.current_functions()
    } else {
        let mut new_reg: FunctionRegistry = (*ctx.current_functions()).clone();
        for k in &meta.local_fn_keys {
            new_reg.insert(k.clone(), FnEntry::body(body_obj[k].clone()));
        }
        Arc::new(new_reg)
    };

    // Bind parameters to args.
    let mut evaluated_vars: Map<String, Value> = Map::new();
    if let Some(Value::Array(params)) = body_obj.get("$params") {
        for (i, p) in params.iter().enumerate() {
            let Some(name) = p.as_str() else { continue };
            if name.is_empty() {
                continue;
            }
            if let Some(rest_name) = name.strip_prefix("...") {
                validate_param_name(rest_name)?;
                let rest: Vec<Value> = if i < args.len() {
                    args[i..].to_vec()
                } else {
                    Vec::new()
                };
                evaluated_vars.insert(rest_name.to_string(), Value::Array(rest));
                break;
            }
            validate_param_name(name)?;
            let val = args.get(i).cloned().unwrap_or(Value::Null);
            evaluated_vars.insert(name.to_string(), val);
        }
    }

    let frame = Rc::new(Frame {
        body: meta.clone(),
        evaluated_vars: RefCell::new(evaluated_vars),
        resolving: RefCell::new(Vec::new()),
        functions: frame_functions,
        parent: ctx.frame.clone(),
    });

    // If we have local fns, the bodies might mention enclosing-scope vars;
    // bake them in now (replace_vars) so closures capture properly. Matches
    // Go's behaviour.
    if !meta.local_fn_keys.is_empty() {
        let saved = ctx.frame.take();
        ctx.frame = Some(frame.clone());
        let mut baked_entries: Vec<(String, Value)> = Vec::with_capacity(meta.local_fn_keys.len());
        for k in &meta.local_fn_keys {
            let raw = body_obj[k].clone();
            let baked = replace_vars(&raw, ctx, &[])?;
            baked_entries.push((k.clone(), baked));
        }
        ctx.frame = saved;

        let mut new_reg: FunctionRegistry = (*frame.functions).clone();
        for (k, v) in baked_entries {
            new_reg.insert(k, FnEntry::body(v));
        }
        let frame = Rc::new(Frame {
            body: meta.clone(),
            evaluated_vars: RefCell::new(frame.evaluated_vars.borrow().clone()),
            resolving: RefCell::new(frame.resolving.borrow().clone()),
            functions: Arc::new(new_reg),
            parent: frame.parent.clone(),
        });
        return eval_with_frame(body_obj.get("$return").unwrap_or(&Value::Null), frame, ctx);
    }

    eval_with_frame(body_obj.get("$return").unwrap_or(&Value::Null), frame, ctx)
}

fn eval_with_frame(
    expr: &Value,
    frame: Rc<Frame>,
    ctx: &mut EvalCtx,
) -> Result<Value, EvalError> {
    let saved = ctx.frame.take();
    ctx.frame = Some(frame);
    let result = evaluate_expression(expr, ctx);
    ctx.frame = saved;
    result
}

/// Variable lookup walking the scope chain. Returns `Ok(Some(_))` on hit,
/// `Ok(None)` if undefined.
///
/// Takes `Rc<Frame>` (cheap to clone) so the recursive lazy evaluation can
/// reuse the same frame object — no body or cache cloning. This is what
/// makes memoization actually work across a chain of mutually-referencing
/// variables (e.g. `v1=v0+1, v2=v1+1, ...`).
fn frame_get_var(
    frame: &Rc<Frame>,
    name: &str,
    ctx: &mut EvalCtx,
) -> Result<Option<Value>, EvalError> {
    if let Some(v) = frame.evaluated_vars.borrow().get(name) {
        return Ok(Some(v.clone()));
    }

    {
        let resolving = frame.resolving.borrow();
        if let Some(pos) = resolving.iter().position(|n| n == name) {
            let mut cycle: Vec<String> = resolving[pos..].to_vec();
            cycle.push(name.to_string());
            return Err(EvalError(format!(
                "Circular variable dependency detected: {}",
                cycle.join(" -> ")
            )));
        }
    }

    // Lazy: look for a key on this frame's body matching `name`.
    if let Value::Object(obj) = &frame.body.body
        && let Some(expr) = obj.get(name).cloned()
        && name != "$return"
        && name != "$params"
    {
        frame.resolving.borrow_mut().push(name.to_string());
        let result = (|| {
            let value = eval_with_frame(&expr, frame.clone(), ctx)?;
            frame
                .evaluated_vars
                .borrow_mut()
                .insert(name.to_string(), value.clone());
            Ok(value)
        })();
        frame.resolving.borrow_mut().pop();
        return result.map(Some);
    }

    if let Some(parent) = &frame.parent {
        return frame_get_var(&parent.clone(), name, ctx);
    }

    Ok(None)
}

fn current_get_var(name: &str, ctx: &mut EvalCtx) -> Result<Option<Value>, EvalError> {
    let frame = match &ctx.frame {
        Some(f) => f.clone(),
        None => return Ok(None),
    };
    frame_get_var(&frame, name, ctx)
}

fn resolve_var(var_path: &str, ctx: &mut EvalCtx, expression: &Value) -> Result<Value, EvalError> {
    let parsed = parse_path(var_path)?;
    let value = current_get_var(&parsed.variable, ctx)?
        .ok_or_else(|| expr_error(expression, &format!("Variable {} not found.", parsed.variable)))?;
    if parsed.path.is_empty() {
        Ok(value)
    } else {
        Ok(walk_path(&value, &parsed.path))
    }
}

#[derive(Copy, Clone, Debug)]
enum ExprKind {
    FunctionCall,
    FunctionReference,
    VariableReference,
    FunctionBody,
    Conditional,
    Cond,
    And,
    Or,
    PropertyAccess,
    Literal,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Null,
}

fn classify(expr: &Value) -> Result<ExprKind, EvalError> {
    match expr {
        Value::Null => Ok(ExprKind::Null),
        Value::Bool(_) => Ok(ExprKind::Boolean),
        Value::Number(_) => Ok(ExprKind::Number),
        Value::String(_) => Ok(ExprKind::String),
        Value::Array(_) => Ok(ExprKind::Array),
        Value::Object(obj) => classify_object(obj, expr),
    }
}

fn classify_object(obj: &Map<String, Value>, expr: &Value) -> Result<ExprKind, EvalError> {
    if let Some(v) = obj.get("$var") {
        if !v.is_string() {
            return Err(expr_error(expr, "Variable references must have a string $var property."));
        }
        let key_count = obj.len();
        if obj.contains_key("$get") {
            if key_count > 2 {
                return Err(expr_error(expr, "$var/$get property access cannot have other properties."));
            }
            return Ok(ExprKind::PropertyAccess);
        }
        if key_count > 1 {
            return Err(expr_error(expr, "Variable references cannot have other properties."));
        }
        return Ok(ExprKind::VariableReference);
    }

    let has_get = obj.contains_key("$get");
    let has_from = obj.contains_key("$from");
    if has_get || has_from {
        if !(has_get && has_from) {
            return Err(expr_error(expr, "Property access expressions must have both $get and $from."));
        }
        if obj.len() > 2 {
            return Err(expr_error(expr, "Property access expressions cannot have more than two properties."));
        }
        return Ok(ExprKind::PropertyAccess);
    }

    if obj.contains_key("$return") {
        if obj.contains_key("$fn") {
            return Err(expr_error(expr, "Function bodies cannot have other keyword properties."));
        }
        if let Some(params) = obj.get("$params") {
            let arr = params
                .as_array()
                .ok_or_else(|| expr_error(expr, "$params must be an array of strings."))?;
            for p in arr {
                let s = p
                    .as_str()
                    .ok_or_else(|| expr_error(expr, "$params must be an array of strings."))?;
                let name = s.strip_prefix("...").unwrap_or(s);
                validate_param_name(name)?;
            }
        }
        return Ok(ExprKind::FunctionBody);
    }

    if let Some(fn_val) = obj.get("$fn") {
        if fn_val.is_array() {
            if obj.len() > 1 {
                return Err(expr_error(expr, "Function calls cannot have other properties."));
            }
            return Ok(ExprKind::FunctionCall);
        }
        if matches!(fn_val, Value::String(_) | Value::Object(_)) {
            if obj.len() > 1 {
                return Err(expr_error(expr, "Function references cannot have other properties."));
            }
            return Ok(ExprKind::FunctionReference);
        }
    }

    let has_if = obj.contains_key("$if");
    let has_then = obj.contains_key("$then");
    let has_else = obj.contains_key("$else");
    if has_if || has_then || has_else {
        if !(has_if && has_then && has_else) {
            return Err(expr_error(
                expr,
                "Conditional expressions must have all three properties: $if, $then, $else.",
            ));
        }
        if obj.len() > 3 {
            return Err(expr_error(expr, "Conditional expressions cannot have more than three properties."));
        }
        return Ok(ExprKind::Conditional);
    }

    if let Some(cond) = obj.get("$cond") {
        if obj.len() > 1 {
            return Err(expr_error(expr, "$cond expressions cannot have other properties."));
        }
        let arr = cond
            .as_array()
            .ok_or_else(|| expr_error(expr, "$cond must be an array of [condition, result] pairs."))?;
        for pair in arr {
            let pa = pair
                .as_array()
                .ok_or_else(|| expr_error(expr, "Each $cond branch must be a [condition, result] pair."))?;
            if pa.len() != 2 {
                return Err(expr_error(expr, "Each $cond branch must be a [condition, result] pair."));
            }
        }
        return Ok(ExprKind::Cond);
    }

    if let Some(and) = obj.get("$and") {
        if obj.len() > 1 {
            return Err(expr_error(expr, "$and expressions cannot have other properties."));
        }
        if !and.is_array() {
            return Err(expr_error(expr, "$and must be an array of expressions."));
        }
        return Ok(ExprKind::And);
    }

    if let Some(or) = obj.get("$or") {
        if obj.len() > 1 {
            return Err(expr_error(expr, "$or expressions cannot have other properties."));
        }
        if !or.is_array() {
            return Err(expr_error(expr, "$or must be an array of expressions."));
        }
        return Ok(ExprKind::Or);
    }

    if obj.contains_key("$literal") {
        if obj.len() > 1 {
            return Err(expr_error(expr, "$literal expressions cannot have other properties."));
        }
        return Ok(ExprKind::Literal);
    }

    Ok(ExprKind::Object)
}

fn evaluate_expression(expr: &Value, ctx: &mut EvalCtx) -> Result<Value, EvalError> {
    // Hot path: scalar literals don't need classification, cancel polling,
    // or operation accounting (they're O(1) and unconditional return-clones).
    // This matters a lot for arithmetic-heavy benchmarks where most of the
    // expression tree is `add(...,1)` style with a literal `1` at the bottom.
    match expr {
        Value::Null => return Ok(Value::Null),
        Value::Bool(_) | Value::Number(_) | Value::String(_) => return Ok(expr.clone()),
        _ => {}
    }

    if let Some(cancel) = &ctx.limits.cancel
        && cancel.load(Ordering::Relaxed)
    {
        return Err(EvalError("Execution aborted".into()));
    }
    if ctx.limits.max_operations > 0 {
        ctx.state.operations += 1;
        if ctx.state.operations > ctx.limits.max_operations {
            return Err(EvalError(format!(
                "Maximum operations limit of {} exceeded",
                ctx.limits.max_operations
            )));
        }
    }

    let kind = classify(expr)?;
    match kind {
        ExprKind::FunctionCall => {
            let obj = expr.as_object().unwrap();
            let fn_arr = obj["$fn"].as_array().unwrap();
            // Hot-path: when the callee is a literal string, skip the full
            // evaluate_expression dispatch (classify + clone) since it would
            // just return the same string back.
            let mut args: Vec<Value> = Vec::with_capacity(fn_arr.len() - 1);
            for arg in &fn_arr[1..] {
                args.push(evaluate_expression(arg, ctx)?);
            }
            if matches!(&fn_arr[0], Value::String(_)) {
                return call_function_internal(&fn_arr[0], &args, ctx);
            }
            let evaluated_fn = evaluate_expression(&fn_arr[0], ctx)?;
            if !is_fn_declaration(&evaluated_fn) {
                return Err(expr_error(
                    expr,
                    &format!(
                        "Evaluated function references must be strings or function bodies. Got {}.",
                        type_name(&evaluated_fn)
                    ),
                ));
            }
            call_function_internal(&evaluated_fn, &args, ctx)
        }
        ExprKind::FunctionReference => {
            let obj = expr.as_object().unwrap();
            let evaluated = evaluate_expression(&obj["$fn"], ctx)?;
            if !is_fn_declaration(&evaluated) {
                return Err(expr_error(
                    expr,
                    &format!(
                        "Evaluated function references must be strings or function bodies. Got {}.",
                        type_name(&evaluated)
                    ),
                ));
            }
            Ok(evaluated)
        }
        ExprKind::VariableReference => {
            let obj = expr.as_object().unwrap();
            let var_name = obj["$var"].as_str().unwrap();
            if ctx.frame.is_none() {
                return Err(expr_error(expr, "getVar is not defined."));
            }
            resolve_var(var_name, ctx, expr)
        }
        ExprKind::FunctionBody => {
            if ctx.frame.is_some() {
                replace_vars(expr, ctx, &[])
            } else {
                Ok(expr.clone())
            }
        }
        ExprKind::Conditional => {
            let obj = expr.as_object().unwrap();
            let cond = evaluate_expression(&obj["$if"], ctx)?;
            if is_truthy(&cond) {
                evaluate_expression(&obj["$then"], ctx)
            } else {
                evaluate_expression(&obj["$else"], ctx)
            }
        }
        ExprKind::Cond => {
            let obj = expr.as_object().unwrap();
            let pairs = obj["$cond"].as_array().unwrap();
            for pair in pairs {
                let branch = pair.as_array().unwrap();
                let cond = evaluate_expression(&branch[0], ctx)?;
                if is_truthy(&cond) {
                    return evaluate_expression(&branch[1], ctx);
                }
            }
            Err(expr_error(expr, "No $cond branch matched (add a [true, ...] catch-all)."))
        }
        ExprKind::And => {
            let obj = expr.as_object().unwrap();
            let exprs = obj["$and"].as_array().unwrap();
            let mut result = Value::Bool(true);
            for e in exprs {
                result = evaluate_expression(e, ctx)?;
                if !is_truthy(&result) {
                    return Ok(result);
                }
            }
            Ok(result)
        }
        ExprKind::Or => {
            let obj = expr.as_object().unwrap();
            let exprs = obj["$or"].as_array().unwrap();
            let mut result = Value::Bool(false);
            for e in exprs {
                result = evaluate_expression(e, ctx)?;
                if is_truthy(&result) {
                    return Ok(result);
                }
            }
            Ok(result)
        }
        ExprKind::PropertyAccess => evaluate_property_access(expr, ctx),
        ExprKind::Literal => {
            let obj = expr.as_object().unwrap();
            Ok(obj["$literal"].clone())
        }
        ExprKind::Array => {
            let arr = expr.as_array().unwrap();
            let mut out = Vec::with_capacity(arr.len());
            for item in arr {
                out.push(evaluate_expression(item, ctx)?);
            }
            Ok(Value::Array(out))
        }
        ExprKind::Object => {
            let obj = expr.as_object().unwrap();
            let mut out = Map::new();
            for (k, v) in obj {
                out.insert(k.clone(), evaluate_expression(v, ctx)?);
            }
            Ok(Value::Object(out))
        }
        ExprKind::String | ExprKind::Number | ExprKind::Boolean | ExprKind::Null => {
            Ok(expr.clone())
        }
    }
}

fn evaluate_property_access(expr: &Value, ctx: &mut EvalCtx) -> Result<Value, EvalError> {
    let obj = expr.as_object().unwrap();
    let evaluated_key = evaluate_expression(&obj["$get"], ctx)?;

    let evaluated_target = if let Some(Value::String(var_name)) = obj.get("$var") {
        if ctx.frame.is_none() {
            return Err(expr_error(expr, "getVar is not defined."));
        }
        resolve_var(var_name, ctx, expr)?
    } else {
        evaluate_expression(&obj["$from"], ctx)?
    };

    if evaluated_target.is_null() {
        return Err(EvalError(
            "Invalid $get target: expected object, array, or string, got null".into(),
        ));
    }

    match &evaluated_target {
        Value::String(s) => {
            if let Some(n) = to_f64(&evaluated_key) {
                let i = n as i64;
                let bytes = s.as_bytes();
                if i >= 0 && (i as usize) < bytes.len() {
                    return Ok(Value::String((bytes[i as usize] as char).to_string()));
                }
                return Ok(Value::Null);
            }
            let key_json = serde_json::to_string(&evaluated_key).unwrap_or_default();
            Err(EvalError(format!(
                "Invalid $get key for string: expected number, got {key_json}"
            )))
        }
        Value::Object(_) | Value::Array(_) => property_lookup(&evaluated_target, &evaluated_key),
        other => {
            let target_json = serde_json::to_string(other).unwrap_or_default();
            Err(EvalError(format!(
                "Invalid $get target: expected object, array, or string, got {target_json}"
            )))
        }
    }
}

fn property_lookup(target: &Value, key: &Value) -> Result<Value, EvalError> {
    match key {
        Value::String(k) => {
            if let Value::Object(map) = target {
                Ok(map.get(k).cloned().unwrap_or(Value::Null))
            } else {
                Ok(Value::Null)
            }
        }
        Value::Number(_) => {
            let idx = to_f64(key).map(|n| n as i64).unwrap_or(-1);
            if let Value::Array(arr) = target {
                if idx >= 0 && (idx as usize) < arr.len() {
                    Ok(arr[idx as usize].clone())
                } else {
                    Ok(Value::Null)
                }
            } else {
                Ok(Value::Null)
            }
        }
        Value::Array(segments) => {
            let mut current = target.clone();
            for seg in segments {
                if current.is_null() {
                    return Ok(Value::Null);
                }
                match seg {
                    Value::String(s) => {
                        if let Value::Object(map) = &current {
                            match map.get(s) {
                                Some(v) => {
                                    let next = v.clone();
                                    current = next;
                                }
                                None => return Ok(Value::Null),
                            }
                        } else {
                            return Ok(Value::Null);
                        }
                    }
                    Value::Number(_) => {
                        let i = to_f64(seg).map(|n| n as i64).unwrap_or(-1);
                        if let Value::Array(arr) = &current {
                            if i >= 0 && (i as usize) < arr.len() {
                                current = arr[i as usize].clone();
                            } else {
                                return Ok(Value::Null);
                            }
                        } else {
                            return Ok(Value::Null);
                        }
                    }
                    other => {
                        let s = serde_json::to_string(other).unwrap_or_default();
                        return Err(EvalError(format!("Invalid $get path segment: {s}")));
                    }
                }
            }
            Ok(current)
        }
        other => {
            let s = serde_json::to_string(other).unwrap_or_default();
            Err(EvalError(format!(
                "Invalid $get key: expected string, number, or array of strings/numbers, got {s}"
            )))
        }
    }
}

/// Substitutes free `$var` references inside an expression with values from
/// the current scope chain. Used when returning a function body so that
/// outer variables get baked into the closure. Local names introduced by
/// nested `$params` / body keys are tracked in `mask` and not substituted.
///
/// Lookups use the same lazy resolution as runtime `$var` evaluation so that
/// closures over body-local variables (e.g. `allArgs` in `curryApply`) get
/// correctly baked in. Mirrors Go's `replaceVars`.
fn replace_vars(
    expr: &Value,
    ctx: &mut EvalCtx,
    mask: &[String],
) -> Result<Value, EvalError> {
    match expr {
        Value::Array(arr) => {
            let mut out = Vec::with_capacity(arr.len());
            for item in arr {
                out.push(replace_vars(item, ctx, mask)?);
            }
            Ok(Value::Array(out))
        }
        Value::Object(obj) => {
            if let Some(Value::String(var_name)) = obj.get("$var") {
                let parsed = parse_path(var_name)?;
                let masked = mask.iter().any(|m| m == &parsed.variable);
                let var_value: Option<Value> = if masked {
                    None
                } else {
                    current_get_var(&parsed.variable, ctx)?
                };

                if obj.contains_key("$get") {
                    let replaced_key = replace_vars(&obj["$get"], ctx, mask)?;
                    if let Some(value) = var_value {
                        let from = build_var_target(value, &parsed);
                        let mut out = Map::new();
                        out.insert("$get".into(), replaced_key);
                        out.insert("$from".into(), from);
                        return Ok(Value::Object(out));
                    }
                    let mut out = Map::new();
                    out.insert("$var".into(), Value::String(var_name.clone()));
                    out.insert("$get".into(), replaced_key);
                    return Ok(Value::Object(out));
                }

                let Some(value) = var_value else {
                    return Ok(expr.clone());
                };
                if !parsed.path.is_empty() {
                    return Ok(build_var_target(value, &parsed));
                }
                return Ok(value);
            }

            if obj.contains_key("$return") {
                let mut local_names: Vec<String> = obj
                    .keys()
                    .filter(|k| k.as_str() != "$return" && k.as_str() != "$params")
                    .cloned()
                    .collect();
                if let Some(Value::Array(params)) = obj.get("$params") {
                    for p in params {
                        if let Some(s) = p.as_str() {
                            let name = s.strip_prefix("...").unwrap_or(s);
                            local_names.push(name.to_string());
                        }
                    }
                }
                let mut new_mask: Vec<String> = mask.to_vec();
                for n in local_names {
                    if !new_mask.contains(&n) {
                        new_mask.push(n);
                    }
                }
                let mut out = Map::new();
                for (k, v) in obj {
                    out.insert(k.clone(), replace_vars(v, ctx, &new_mask)?);
                }
                return Ok(Value::Object(out));
            }

            let mut out = Map::new();
            for (k, v) in obj {
                out.insert(k.clone(), replace_vars(v, ctx, mask)?);
            }
            Ok(Value::Object(out))
        }
        _ => Ok(expr.clone()),
    }
}

fn build_var_target(var_value: Value, parsed: &ParsedPath) -> Value {
    if parsed.path.is_empty() {
        return var_value;
    }
    let path_key = if parsed.path.len() == 1 {
        segment_to_value(&parsed.path[0])
    } else {
        Value::Array(parsed.path.iter().map(segment_to_value).collect())
    };
    let mut out = Map::new();
    out.insert("$get".into(), path_key);
    out.insert("$from".into(), var_value);
    Value::Object(out)
}

fn segment_to_value(s: &Segment) -> Value {
    match s {
        Segment::Key(k) => Value::String(k.clone()),
        Segment::Index(i) => Value::Number(serde_json::Number::from(*i)),
    }
}
