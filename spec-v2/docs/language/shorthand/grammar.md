# Grammar (informal EBNF)

```
program     := (moduleEntry (moduleSep moduleEntry)*)?
moduleSep   := physical line break after a complete moduleEntry
moduleEntry := "type" ident "=" type
             | (ident | string) ":" expr
expressionInput := body

expr        := ascription
ascription  := orExpr ( "checked" "as" type )?                   // non-assoc
orExpr      := andExpr ( "||" andExpr )*
andExpr     := cmpExpr ( "&&" cmpExpr )*
cmpExpr     := coalesce ( ("=="|"!="|"<"|"<="|">"|">=") coalesce )*
               // Multiple operators must all be ordered: < <= > >=
coalesce    := addExpr ( "??" coalesce )?            // right-assoc; left
               // operand must be a property/index access (checked at lowering)
addExpr     := mulExpr ( ("+"|"-"|"++") mulExpr )*
mulExpr     := unary ( ("*"|"/"|"%") unary )*
unary       := ("!"|"-") unary | postfix
postfix     := primary ( "." ident
                       | "[" (int | string) "]"      // static
                       | "[" expr "]"                // computed
                       | "(" args ")"
                       | "!" )*                      // non-null assertion
args        := (arg ("," arg)*)?
arg         := expr | "..." expr
primary     := number | string | template | "true" | "false" | "null"
             | ident                                 // variable, or fn name if called
             | "&" ident | "&" "(" expr ")"          // function reference
             | "(" body ")"
             | funcLit
             | "[" (arrayEntry ("," arrayEntry)*)? "]"
             | "{" (objectEntry ("," objectEntry)*)? "}"
             | "if" expr "then" expr "else" expr
             | "cond" "{" arm ("," arm)* "}"
             | "match" expr "{" arm ("," arm)* "}"
             | "do" "{" doEntry ("," doEntry)* "}"
             | "handle" expr ( "returns" type )? "with"
                        "{" (objectEntry ("," objectEntry)*)? "}"

funcLit     := "(" params ")" "=>" body
body        := expr ( "where" "{" binding ("," binding)* "}" )?
binding     := ident ":" body
params      := ( param ("," param)* )?               // last may be "...ident"
param       := ident ( "?" | "=" expr )?
             | "..." ident                           // rest (last slot only)
             | objectPattern
objectPattern := "{" fieldBinding ("," fieldBinding)* ","? "}"
fieldBinding  := ident ( "?" | "=" expr )?
arrayEntry  := expr | "..." expr
objectEntry := (ident | string) ":" expr
             | ident                                 // punned
             | "..." expr
             | "[" expr "]" ":" expr
doEntry     := ident "<-" expr                       // effect binding
             | ident ":" body                        // pure (local) binding
             | body                                  // discard (non-final) / result (final)
arm         := (expr | "else") ":" body
template    := "`" ( char | "${" expr "}" )* "`"     // strict; no coercion
ident       := [A-Za-z_][A-Za-z0-9_]*
```

Required positional and object-pattern parameters precede all `?`/`=`
positional parameters; a rest parameter, when present, is final. These ordering
rules apply to `param` entries, not to `fieldBinding` entries within one
required object pattern.

See [Type syntax](type-syntax-spec.md#informal-grammar) for typed function
parameters, return annotations, type expressions, and type declarations.

