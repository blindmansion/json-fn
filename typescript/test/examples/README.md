# Test examples

This directory contains realistic json-fn programs that automated tests rely
on. Unlike the public examples, these files may encode deterministic hosts,
oracles, and edge cases whose shape is chosen for repeatable assertions.

Keep fixtures focused on plausible application behavior rather than isolated
syntax fragments. Public examples should not contain test-only interpreters or
mock entry points; put those here and exercise them from a test.
