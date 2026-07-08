//! Recursive-descent + precedence-climbing parser that lowers `.jfn` shorthand
//! directly to canonical json-fn JSON (`serde_json::Value`). There is no
//! separate shorthand AST: the canonical JSON *is* the tree, and the lowering
//! rules from `docs/shorthand-spec.md` are applied inline.

use serde_json::{Map, Number, Value};

use super::error::ParseError;
use super::lexer::{TemplatePart, Tok, Token, lex};

/// Parse a full `.jfn` expression, returning canonical json-fn JSON.
pub fn parse(src: &str) -> Result<Value, ParseError> {
    let tokens = lex(src)?;
    let mut p = Parser { tokens, pos: 0 };
    let v = p.parse_expr()?;
    p.expect(Tok::Eof, "end of input")?;
    Ok(v)
}

struct Parser {
    tokens: Vec<Token>,
    pos: usize,
}

/// One property-access step gathered during postfix parsing.
enum Seg {
    /// A literal key/index that folds into a `$get` path (`.name`, `[0]`,
    /// `["key"]`).
    Static(Value),
    /// A computed key (`[expr]`) that breaks a static run into `$get`/`$from`.
    Computed(Value),
}

/// The innermost thing a property-access chain is rooted at.
enum Base {
    Var(String),
    Expr(Value),
}

impl Parser {
    fn peek(&self) -> &Tok {
        &self.tokens[self.pos].tok
    }

    fn advance(&mut self) -> Tok {
        let t = self.tokens[self.pos].tok.clone();
        if self.pos + 1 < self.tokens.len() {
            self.pos += 1;
        }
        t
    }

    fn err(&self, msg: impl Into<String>) -> ParseError {
        let t = &self.tokens[self.pos];
        ParseError::new(msg, t.line, t.col)
    }

    fn expect(&mut self, tok: Tok, what: &str) -> Result<(), ParseError> {
        if *self.peek() == tok {
            self.advance();
            Ok(())
        } else {
            Err(self.err(format!("expected {what}, found {:?}", self.peek())))
        }
    }

    fn is_keyword(&self, kw: &str) -> bool {
        matches!(self.peek(), Tok::Ident(s) if s == kw)
    }

    fn eat_keyword(&mut self, kw: &str) -> bool {
        if self.is_keyword(kw) {
            self.advance();
            true
        } else {
            false
        }
    }

    fn expect_keyword(&mut self, kw: &str) -> Result<(), ParseError> {
        if self.eat_keyword(kw) {
            Ok(())
        } else {
            Err(self.err(format!("expected '{kw}', found {:?}", self.peek())))
        }
    }

    fn expect_ident(&mut self, what: &str) -> Result<String, ParseError> {
        match self.peek().clone() {
            Tok::Ident(s) => {
                self.advance();
                Ok(s)
            }
            other => Err(self.err(format!("expected {what}, found {other:?}"))),
        }
    }

    // ----- expression precedence ladder (spec section 6) -----

    fn parse_expr(&mut self) -> Result<Value, ParseError> {
        self.parse_or()
    }

    fn parse_or(&mut self) -> Result<Value, ParseError> {
        let mut parts = vec![self.parse_and()?];
        while *self.peek() == Tok::OrOr {
            self.advance();
            parts.push(self.parse_and()?);
        }
        if parts.len() == 1 {
            Ok(parts.pop().unwrap())
        } else {
            Ok(obj(vec![("$or", Value::Array(parts))]))
        }
    }

    fn parse_and(&mut self) -> Result<Value, ParseError> {
        let mut parts = vec![self.parse_cmp()?];
        while *self.peek() == Tok::AndAnd {
            self.advance();
            parts.push(self.parse_cmp()?);
        }
        if parts.len() == 1 {
            Ok(parts.pop().unwrap())
        } else {
            Ok(obj(vec![("$and", Value::Array(parts))]))
        }
    }

    fn parse_cmp(&mut self) -> Result<Value, ParseError> {
        let left = self.parse_add()?;
        let key = match self.peek() {
            Tok::EqEq => "$eq",
            Tok::BangEq => "$neq",
            Tok::Lt => "$lt",
            Tok::LtEq => "$lte",
            Tok::Gt => "$gt",
            Tok::GtEq => "$gte",
            _ => return Ok(left),
        };
        self.advance();
        let right = self.parse_add()?;
        // Non-associative: reject `a < b < c`.
        if matches!(
            self.peek(),
            Tok::EqEq | Tok::BangEq | Tok::Lt | Tok::LtEq | Tok::Gt | Tok::GtEq
        ) {
            return Err(self.err("comparison operators are non-associative"));
        }
        Ok(obj(vec![(key, Value::Array(vec![left, right]))]))
    }

    fn parse_add(&mut self) -> Result<Value, ParseError> {
        let mut left = self.parse_mul()?;
        // Tracks whether `left` is a `strcat` node produced by `++` at this
        // level, so a run of `++` flattens into one variadic call.
        let mut left_is_concat = false;
        loop {
            match self.peek() {
                Tok::Plus => {
                    self.advance();
                    let right = self.parse_mul()?;
                    left = fncall("add", vec![left, right]);
                    left_is_concat = false;
                }
                Tok::Minus => {
                    self.advance();
                    let right = self.parse_mul()?;
                    left = fncall("sub", vec![left, right]);
                    left_is_concat = false;
                }
                Tok::PlusPlus => {
                    self.advance();
                    let right = self.parse_mul()?;
                    if left_is_concat {
                        push_arg(&mut left, right);
                    } else {
                        left = fncall("strcat", vec![left, right]);
                        left_is_concat = true;
                    }
                }
                _ => return Ok(left),
            }
        }
    }

    fn parse_mul(&mut self) -> Result<Value, ParseError> {
        let mut left = self.parse_unary()?;
        loop {
            let name = match self.peek() {
                Tok::Star => "mul",
                Tok::Slash => "div",
                Tok::Percent => "mod",
                _ => return Ok(left),
            };
            self.advance();
            let right = self.parse_unary()?;
            left = fncall(name, vec![left, right]);
        }
    }

    fn parse_unary(&mut self) -> Result<Value, ParseError> {
        match self.peek() {
            Tok::Bang => {
                self.advance();
                let e = self.parse_unary()?;
                Ok(obj(vec![("$not", e)]))
            }
            Tok::Minus => {
                self.advance();
                let e = self.parse_unary()?;
                // `-<number literal>` folds into a negative literal; otherwise
                // it is `neg(expr)`.
                match e {
                    Value::Number(n) => Ok(Value::Number(negate_number(&n))),
                    other => Ok(fncall("neg", vec![other])),
                }
            }
            _ => self.parse_postfix(),
        }
    }

    fn parse_postfix(&mut self) -> Result<Value, ParseError> {
        let (mut val, mut name) = self.parse_primary()?;
        loop {
            match self.peek() {
                Tok::LParen => {
                    // Bare identifier in call position is a literal function
                    // name; anything else is an evaluated callee (spec section 4).
                    let callee = match &name {
                        Some(n) => Value::String(n.clone()),
                        None => val.clone(),
                    };
                    self.advance();
                    let args = self.parse_call_args()?;
                    let mut arr = Vec::with_capacity(args.len() + 1);
                    arr.push(callee);
                    arr.extend(args);
                    val = obj(vec![("$fn", Value::Array(arr))]);
                    name = None;
                }
                Tok::Dot | Tok::LBracket => {
                    let segs = self.gather_access()?;
                    let base = match name.take() {
                        Some(n) => Base::Var(n),
                        None => Base::Expr(val),
                    };
                    val = build_access(base, segs);
                }
                _ => return Ok(val),
            }
        }
    }

    /// Consume a maximal run of `.name` / `[...]` access segments.
    fn gather_access(&mut self) -> Result<Vec<Seg>, ParseError> {
        let mut segs = Vec::new();
        loop {
            match self.peek() {
                Tok::Dot => {
                    self.advance();
                    let key = self.expect_ident("property name after '.'")?;
                    segs.push(Seg::Static(Value::String(key)));
                }
                Tok::LBracket => {
                    self.advance();
                    let inner = self.parse_expr()?;
                    self.expect(Tok::RBracket, "']'")?;
                    // Literal string/number keys are static (foldable);
                    // everything else is a computed key.
                    match inner {
                        Value::String(_) | Value::Number(_) => segs.push(Seg::Static(inner)),
                        other => segs.push(Seg::Computed(other)),
                    }
                }
                _ => return Ok(segs),
            }
        }
    }

    // ----- primary expressions -----

    /// Returns the primary's value plus, for a bare identifier, its name (so
    /// the postfix loop can decide named-call vs variable-reference).
    fn parse_primary(&mut self) -> Result<(Value, Option<String>), ParseError> {
        match self.peek().clone() {
            Tok::Num(n) => {
                self.advance();
                Ok((Value::Number(n), None))
            }
            Tok::Str(s) => {
                self.advance();
                Ok((Value::String(s), None))
            }
            Tok::Template(parts) => {
                self.advance();
                Ok((self.lower_template(parts)?, None))
            }
            Tok::Amp => {
                self.advance();
                Ok((self.parse_fn_reference()?, None))
            }
            Tok::LBracket => {
                self.advance();
                Ok((self.parse_array()?, None))
            }
            Tok::LBrace => {
                self.advance();
                Ok((self.parse_data_object()?, None))
            }
            Tok::LParen => {
                if self.looks_like_func_lit() {
                    Ok((self.parse_func_lit()?, None))
                } else {
                    self.advance();
                    let e = self.parse_expr()?;
                    self.expect(Tok::RParen, "')'")?;
                    Ok((e, None))
                }
            }
            Tok::Ident(name) => match name.as_str() {
                "true" => {
                    self.advance();
                    Ok((Value::Bool(true), None))
                }
                "false" => {
                    self.advance();
                    Ok((Value::Bool(false), None))
                }
                "null" => {
                    self.advance();
                    Ok((Value::Null, None))
                }
                "if" => {
                    self.advance();
                    Ok((self.parse_if()?, None))
                }
                "cond" => {
                    self.advance();
                    Ok((self.parse_cond()?, None))
                }
                "match" => {
                    self.advance();
                    Ok((self.parse_match()?, None))
                }
                "raw" => {
                    self.advance();
                    Ok((self.parse_raw()?, None))
                }
                "let" => {
                    Err(self
                        .err("the 'let { ... } in expr' form is replaced by 'expr where { ... }'"))
                }
                "where" => {
                    Err(self.err("'where { ... }' is only valid immediately after a function body"))
                }
                _ => {
                    self.advance();
                    Ok((obj(vec![("$var", Value::String(name.clone()))]), Some(name)))
                }
            },
            other => Err(self.err(format!("unexpected token {other:?}"))),
        }
    }

    fn parse_fn_reference(&mut self) -> Result<Value, ParseError> {
        // `&` already consumed.
        if *self.peek() == Tok::LParen {
            self.advance();
            let e = self.parse_expr()?;
            self.expect(Tok::RParen, "')'")?;
            Ok(obj(vec![("$fn", e)]))
        } else {
            let name = self.expect_ident("function name after '&'")?;
            Ok(obj(vec![("$fn", Value::String(name))]))
        }
    }

    fn parse_array(&mut self) -> Result<Value, ParseError> {
        // `[` already consumed.
        let mut els = Vec::new();
        if *self.peek() == Tok::RBracket {
            self.advance();
            return Ok(Value::Array(els));
        }
        loop {
            els.push(self.parse_expr()?);
            match self.peek() {
                Tok::Comma => {
                    self.advance();
                    if *self.peek() == Tok::RBracket {
                        self.advance();
                        break;
                    }
                }
                Tok::RBracket => {
                    self.advance();
                    break;
                }
                _ => return Err(self.err("expected ',' or ']' in array")),
            }
        }
        Ok(Value::Array(els))
    }

    fn parse_data_object(&mut self) -> Result<Value, ParseError> {
        // `{` already consumed. Keys are literal data; values are evaluated.
        let mut map = Map::new();
        if *self.peek() == Tok::RBrace {
            self.advance();
            return Ok(Value::Object(map));
        }
        loop {
            let key = match self.peek().clone() {
                Tok::Ident(s) => {
                    self.advance();
                    s
                }
                Tok::Str(s) => {
                    self.advance();
                    s
                }
                other => {
                    return Err(self.err(format!("expected data-object key, found {other:?}")));
                }
            };
            if key.starts_with('$') {
                return Err(self.err(format!(
                    "data-object key \"{key}\" must not start with '$'; use 'raw' for $-keyed data"
                )));
            }
            self.expect(Tok::Colon, "':' after data-object key")?;
            let value = self.parse_expr()?;
            map.insert(key, value);
            match self.peek() {
                Tok::Comma => {
                    self.advance();
                    if *self.peek() == Tok::RBrace {
                        self.advance();
                        break;
                    }
                }
                Tok::RBrace => {
                    self.advance();
                    break;
                }
                _ => return Err(self.err("expected ',' or '}' in data object")),
            }
        }
        Ok(Value::Object(map))
    }

    // ----- function literals & where-bindings (spec section 8) -----

    /// Peek whether the `(` at the cursor begins `( params ) =>`.
    fn looks_like_func_lit(&self) -> bool {
        debug_assert_eq!(*self.peek(), Tok::LParen);
        let mut depth = 0usize;
        let mut i = self.pos;
        loop {
            match self.tokens.get(i).map(|t| &t.tok) {
                Some(Tok::LParen) => depth += 1,
                Some(Tok::RParen) => {
                    depth -= 1;
                    if depth == 0 {
                        return matches!(
                            self.tokens.get(i + 1).map(|t| &t.tok),
                            Some(Tok::FatArrow)
                        );
                    }
                }
                Some(Tok::Eof) | None => return false,
                _ => {}
            }
            i += 1;
        }
    }

    fn parse_func_lit(&mut self) -> Result<Value, ParseError> {
        let params = self.parse_params()?;
        self.expect(Tok::FatArrow, "'=>'")?;
        // Body is `expr` optionally followed by a `where { ... }` clause
        // supplying the (lazy, order-independent) locals. `where` is not an
        // operator, so `parse_expr` stops before it and we consume it here.
        let ret = self.parse_expr()?;
        let locals = if self.eat_keyword("where") {
            self.parse_where_bindings()?
        } else {
            Vec::new()
        };
        let mut map = Map::new();
        if !params.is_empty() {
            map.insert(
                "$params".to_string(),
                Value::Array(params.into_iter().map(Value::String).collect()),
            );
        }
        for (k, v) in locals {
            map.insert(k, v);
        }
        map.insert("$return".to_string(), ret);
        Ok(Value::Object(map))
    }

    fn parse_params(&mut self) -> Result<Vec<String>, ParseError> {
        self.expect(Tok::LParen, "'('")?;
        let mut params = Vec::new();
        if *self.peek() == Tok::RParen {
            self.advance();
            return Ok(params);
        }
        loop {
            if *self.peek() == Tok::DotDotDot {
                self.advance();
                let name = self.expect_ident("rest parameter name")?;
                params.push(format!("...{name}"));
            } else {
                let name = self.expect_ident("parameter name")?;
                params.push(name);
            }
            match self.peek() {
                Tok::Comma => {
                    self.advance();
                }
                Tok::RParen => {
                    self.advance();
                    break;
                }
                _ => return Err(self.err("expected ',' or ')' in parameter list")),
            }
        }
        Ok(params)
    }

    /// Parse the `{ name: value, ... }` block of a `where` clause (`where`
    /// already consumed), returning the locals in source order.
    fn parse_where_bindings(&mut self) -> Result<Vec<(String, Value)>, ParseError> {
        self.expect(Tok::LBrace, "'{' after 'where'")?;
        let mut locals = Vec::new();
        if *self.peek() != Tok::RBrace {
            loop {
                let name = self.expect_ident("binding name")?;
                self.expect(Tok::Colon, "':' after binding name")?;
                let value = self.parse_expr()?;
                locals.push((name, value));
                match self.peek() {
                    Tok::Comma => {
                        self.advance();
                        if *self.peek() == Tok::RBrace {
                            break;
                        }
                    }
                    Tok::RBrace => break,
                    _ => return Err(self.err("expected ',' or '}' in where-bindings")),
                }
            }
        }
        self.expect(Tok::RBrace, "'}'")?;
        Ok(locals)
    }

    // ----- control flow (spec section 7) -----

    fn parse_if(&mut self) -> Result<Value, ParseError> {
        let cond = self.parse_expr()?;
        self.expect_keyword("then")?;
        let then_ = self.parse_expr()?;
        self.expect_keyword("else")?;
        let else_ = self.parse_expr()?;
        Ok(obj(vec![("$if", cond), ("$then", then_), ("$else", else_)]))
    }

    fn parse_cond(&mut self) -> Result<Value, ParseError> {
        self.expect(Tok::LBrace, "'{' after 'cond'")?;
        let (arms, else_val) = self.parse_arms()?;
        let cases = arms
            .into_iter()
            .map(|(c, r)| Value::Array(vec![c, r]))
            .collect();
        let mut map = Map::new();
        map.insert("$cond".to_string(), Value::Array(cases));
        if let Some(e) = else_val {
            map.insert("$else".to_string(), e);
        }
        Ok(Value::Object(map))
    }

    fn parse_match(&mut self) -> Result<Value, ParseError> {
        let subject = self.parse_expr()?;
        self.expect(Tok::LBrace, "'{' after match subject")?;
        let (arms, else_val) = self.parse_arms()?;
        let cases = arms
            .into_iter()
            .map(|(c, r)| Value::Array(vec![c, r]))
            .collect();
        let mut map = Map::new();
        map.insert("$match".to_string(), subject);
        map.insert("$cases".to_string(), Value::Array(cases));
        match else_val {
            Some(e) => {
                map.insert("$else".to_string(), e);
            }
            None => return Err(self.err("match requires an 'else ->' arm")),
        }
        Ok(Value::Object(map))
    }

    /// Parse the shared `cond`/`match` arm block up to and including the
    /// closing `}`. `else -> expr` becomes the optional else value; every other
    /// `expr -> expr` arm is returned in order.
    #[allow(clippy::type_complexity)]
    fn parse_arms(&mut self) -> Result<(Vec<(Value, Value)>, Option<Value>), ParseError> {
        let mut arms = Vec::new();
        let mut else_val = None;
        if *self.peek() == Tok::RBrace {
            self.advance();
            return Ok((arms, else_val));
        }
        loop {
            if self.eat_keyword("else") {
                self.expect(Tok::Arrow, "'->' after 'else'")?;
                let r = self.parse_expr()?;
                else_val = Some(r);
            } else {
                let c = self.parse_expr()?;
                self.expect(Tok::Arrow, "'->' in arm")?;
                let r = self.parse_expr()?;
                arms.push((c, r));
            }
            match self.peek() {
                Tok::Comma => {
                    self.advance();
                    if *self.peek() == Tok::RBrace {
                        self.advance();
                        break;
                    }
                }
                Tok::RBrace => {
                    self.advance();
                    break;
                }
                _ => return Err(self.err("expected ',' or '}' between arms")),
            }
        }
        Ok((arms, else_val))
    }

    // ----- raw JSON islands (spec section 3) -----

    fn parse_raw(&mut self) -> Result<Value, ParseError> {
        let value = self.parse_raw_json()?;
        Ok(obj(vec![("$raw", value)]))
    }

    /// Parse a strict-JSON value (quoted keys, no shorthand) for a `raw` island.
    fn parse_raw_json(&mut self) -> Result<Value, ParseError> {
        match self.peek().clone() {
            Tok::Num(n) => {
                self.advance();
                Ok(Value::Number(n))
            }
            Tok::Minus => {
                self.advance();
                match self.peek().clone() {
                    Tok::Num(n) => {
                        self.advance();
                        Ok(Value::Number(negate_number(&n)))
                    }
                    other => Err(self.err(format!("expected number after '-', found {other:?}"))),
                }
            }
            Tok::Str(s) => {
                self.advance();
                Ok(Value::String(s))
            }
            Tok::Ident(name) => {
                self.advance();
                match name.as_str() {
                    "true" => Ok(Value::Bool(true)),
                    "false" => Ok(Value::Bool(false)),
                    "null" => Ok(Value::Null),
                    other => Err(self.err(format!("invalid token '{other}' in raw JSON"))),
                }
            }
            Tok::LBracket => {
                self.advance();
                let mut els = Vec::new();
                if *self.peek() == Tok::RBracket {
                    self.advance();
                    return Ok(Value::Array(els));
                }
                loop {
                    els.push(self.parse_raw_json()?);
                    match self.peek() {
                        Tok::Comma => {
                            self.advance();
                            if *self.peek() == Tok::RBracket {
                                self.advance();
                                break;
                            }
                        }
                        Tok::RBracket => {
                            self.advance();
                            break;
                        }
                        _ => return Err(self.err("expected ',' or ']' in raw JSON array")),
                    }
                }
                Ok(Value::Array(els))
            }
            Tok::LBrace => {
                self.advance();
                let mut map = Map::new();
                if *self.peek() == Tok::RBrace {
                    self.advance();
                    return Ok(Value::Object(map));
                }
                loop {
                    let key = match self.peek().clone() {
                        Tok::Str(s) => {
                            self.advance();
                            s
                        }
                        other => {
                            return Err(self.err(format!(
                                "raw JSON object keys must be quoted strings, found {other:?}"
                            )));
                        }
                    };
                    self.expect(Tok::Colon, "':' in raw JSON object")?;
                    let value = self.parse_raw_json()?;
                    map.insert(key, value);
                    match self.peek() {
                        Tok::Comma => {
                            self.advance();
                            if *self.peek() == Tok::RBrace {
                                self.advance();
                                break;
                            }
                        }
                        Tok::RBrace => {
                            self.advance();
                            break;
                        }
                        _ => return Err(self.err("expected ',' or '}' in raw JSON object")),
                    }
                }
                Ok(Value::Object(map))
            }
            other => Err(self.err(format!(
                "expected a JSON value after 'raw', found {other:?}"
            ))),
        }
    }

    // ----- template strings (spec section 6) -----

    fn lower_template(&self, parts: Vec<TemplatePart>) -> Result<Value, ParseError> {
        let mut segs: Vec<Value> = Vec::new();
        for part in parts {
            match part {
                // Empty literal spans (e.g. between adjacent holes, or leading/
                // trailing) contribute nothing.
                TemplatePart::Lit(s) if s.is_empty() => {}
                TemplatePart::Lit(s) => segs.push(Value::String(s)),
                TemplatePart::Hole(src) => segs.push(parse(&src)?),
            }
        }
        // Degenerate forms normalize: no segments -> "", single -> itself.
        match segs.len() {
            0 => Ok(Value::String(String::new())),
            1 => Ok(segs.pop().unwrap()),
            _ => Ok(fncall("strcat", segs)),
        }
    }

    fn parse_call_args(&mut self) -> Result<Vec<Value>, ParseError> {
        // `(` already consumed.
        let mut args = Vec::new();
        if *self.peek() == Tok::RParen {
            self.advance();
            return Ok(args);
        }
        loop {
            args.push(self.parse_expr()?);
            match self.peek() {
                Tok::Comma => {
                    self.advance();
                    if *self.peek() == Tok::RParen {
                        self.advance();
                        break;
                    }
                }
                Tok::RParen => {
                    self.advance();
                    break;
                }
                _ => return Err(self.err("expected ',' or ')' in argument list")),
            }
        }
        Ok(args)
    }
}

// ----- lowering helpers -----

fn obj(pairs: Vec<(&str, Value)>) -> Value {
    let mut map = Map::new();
    for (k, v) in pairs {
        map.insert(k.to_string(), v);
    }
    Value::Object(map)
}

fn fncall(name: &str, args: Vec<Value>) -> Value {
    let mut arr = Vec::with_capacity(args.len() + 1);
    arr.push(Value::String(name.to_string()));
    arr.extend(args);
    obj(vec![("$fn", Value::Array(arr))])
}

/// Append an argument to an existing `{ "$fn": [name, ...] }` call node. Used
/// to flatten a run of `++` into one variadic `strcat`.
fn push_arg(call: &mut Value, arg: Value) {
    if let Value::Object(map) = call
        && let Some(Value::Array(arr)) = map.get_mut("$fn")
    {
        arr.push(arg);
    }
}

fn negate_number(n: &Number) -> Number {
    if let Some(i) = n.as_i64() {
        Number::from(-i)
    } else if let Some(f) = n.as_f64() {
        Number::from_f64(-f).unwrap_or_else(|| n.clone())
    } else {
        n.clone()
    }
}

/// Build a `$var`/`$get` (or `$get`/`$from`) property-access chain from a base
/// and its gathered segments, following the folding rules in spec section 5.
fn build_access(base: Base, segs: Vec<Seg>) -> Value {
    let mut iter = segs.into_iter().peekable();

    // Consume a leading run of static segments; how it attaches depends on
    // whether the base is a variable or an arbitrary expression.
    let leading: Vec<Value> = take_static_run(&mut iter);
    let mut current = match base {
        Base::Var(name) => {
            let mut map = Map::new();
            map.insert("$var".to_string(), Value::String(name));
            if !leading.is_empty() {
                map.insert("$get".to_string(), fold_static(leading));
            } else if matches!(iter.peek(), Some(Seg::Computed(_))) {
                // A computed key as the very first segment attaches straight to
                // the variable as `$get` (e.g. `a[i]`); a computed key *after* a
                // static path instead breaks into `$get`/`$from` below.
                if let Some(Seg::Computed(v)) = iter.next() {
                    map.insert("$get".to_string(), v);
                }
            }
            Value::Object(map)
        }
        Base::Expr(expr) => {
            if leading.is_empty() {
                expr
            } else {
                obj(vec![("$get", fold_static(leading)), ("$from", expr)])
            }
        }
    };

    // Remaining segments: each computed key, or run of statics after a break,
    // wraps the accumulated expression in a fresh `$get`/`$from`.
    while iter.peek().is_some() {
        match iter.next().unwrap() {
            Seg::Computed(v) => {
                current = obj(vec![("$get", v), ("$from", current)]);
            }
            Seg::Static(v) => {
                let mut run = vec![v];
                run.extend(take_static_run(&mut iter));
                current = obj(vec![("$get", fold_static(run)), ("$from", current)]);
            }
        }
    }
    current
}

fn take_static_run(iter: &mut std::iter::Peekable<std::vec::IntoIter<Seg>>) -> Vec<Value> {
    let mut run = Vec::new();
    while matches!(iter.peek(), Some(Seg::Static(_))) {
        if let Some(Seg::Static(v)) = iter.next() {
            run.push(v);
        }
    }
    run
}

/// A single static segment stays a scalar `$get`; multiple fold into an array
/// path.
fn fold_static(mut run: Vec<Value>) -> Value {
    if run.len() == 1 {
        run.pop().unwrap()
    } else {
        Value::Array(run)
    }
}
