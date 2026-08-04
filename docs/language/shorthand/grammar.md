# Grammar (informal EBNF)

```
program     := (moduleEntry (moduleSep moduleEntry)*)?
moduleSep   := physical line break after a complete moduleEntry
moduleEntry := "type" ident "=" type
             | dataEntry

// Used only by an explicit standalone-expression parser mode.
expressionInput := body

expr        := ascription
ascription  := orExpr ( "checked" "as" type )?                   // non-assoc
orExpr      := andExpr ( "||" andExpr )*
andExpr     := cmpExpr ( "&&" cmpExpr )*
cmpExpr     := addExpr ( ("=="|"!="|"<"|"<="|">"|">=") addExpr )*
               // Multiple operators must all be ordered: < <= > >=
addExpr     := mulExpr ( ("+"|"-"|"++") mulExpr )*
mulExpr     := unary ( ("*"|"/"|"%") unary )*
unary       := ("!"|"-") unary | postfix
postfix     := primary ( "." ident
                       | "[" (int | string) "]"      // static
                       | "[" expr "]"                // computed
                       | "(" args ")"
                       | "!" )*                      // non-null assertion
primary     := number | string | template | "true" | "false" | "null"
             | ident                                 // variable, or fn name if called
             | "&" ident | "&" "(" expr ")"          // function reference
             | "(" body ")"
             | funcLit
             | "[" (expr ("," expr)*)? "]"           // array
             | "{" (dataEntry ("," dataEntry)*)? "}" // data object
             | "if" expr "then" expr "else" expr
             | "cond" "{" arm ("," arm)* "}"
             | "match" expr "{" arm ("," arm)* "}"
             | "do" "{" doEntry ("," doEntry)* "}"   // effects (effects.md)
             | "handle" expr ( "returns" type )? "with"
                        "{" (dataEntry ("," dataEntry)*)? "}"     // effects.md

funcLit     := "(" params ")" "=>" body
body        := expr ( "where" "{" binding ("," binding)* "}" )?
binding     := ident ":" body
params      := ( param ("," param)* )?               // last may be "...ident"
param       := ident ( "?" | "=" expr )?
             | "..." ident                           // rest (last slot only)
             | objectPattern
objectPattern := "{" fieldBinding ("," fieldBinding)* ","? "}"
fieldBinding  := ident ( "?" | "=" expr )?
dataEntry   := (ident | string) ":" expr
             | ident                                 // punned: { x } == { x: x }
doEntry     := ident "<-" expr                       // effect binding (effects.md)
             | ident ":" body                        // pure (lazy-local) binding
             | body                                  // discard (non-final) / result (final)
arm         := (expr | "else") ":" body
template    := "`" ( char | "${" expr "}" )* "`"     // strict; no coercion
ident       := [A-Za-z_][A-Za-z0-9_]*
```

Required positional and object-pattern parameters precede all `?`/`=`
positional parameters; a rest parameter, when present, is final. These ordering
rules apply to `param` entries, not to `fieldBinding` entries within one
required object pattern.

Canonical printing uses newline-and-indent for `where`, `cond`, `match`, and long
argument/element lists; single-line for short forms. Parsers accept either.

---

