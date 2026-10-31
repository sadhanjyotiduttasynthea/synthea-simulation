"""Restricted mathematical expression evaluator.

User-defined equations are parsed with Python's ``ast`` module and evaluated by
walking a whitelist of node types. No ``eval``/``exec`` is used, attribute
access, subscripts, comprehensions, lambdas and arbitrary calls are rejected.
"""
from __future__ import annotations

import ast
import math
import operator

MAX_LEN = 500
MAX_POW = 1e6

_BINOPS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.Pow: operator.pow,
    ast.Mod: operator.mod,
}
_UNARY = {ast.UAdd: operator.pos, ast.USub: operator.neg}
_FUNCS = {
    "sqrt": math.sqrt, "exp": math.exp, "log": math.log, "log10": math.log10,
    "sin": math.sin, "cos": math.cos, "tan": math.tan, "abs": abs,
    "min": min, "max": max, "pow": math.pow, "tanh": math.tanh,
}
_CONSTS = {"pi": math.pi, "e": math.e}


class ExpressionError(ValueError):
    pass


def _eval(node, variables):
    if isinstance(node, ast.Expression):
        return _eval(node.body, variables)
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)) and not isinstance(node.value, bool):
        return float(node.value)
    if isinstance(node, ast.Name):
        if node.id in variables:
            return float(variables[node.id])
        if node.id in _CONSTS:
            return _CONSTS[node.id]
        raise ExpressionError(f"Unknown variable '{node.id}'")
    if isinstance(node, ast.BinOp) and type(node.op) in _BINOPS:
        a = _eval(node.left, variables)
        b = _eval(node.right, variables)
        if isinstance(node.op, ast.Pow) and abs(b) > 100 and abs(a) > 1:
            raise ExpressionError("Exponent too large")
        r = _BINOPS[type(node.op)](a, b)
        if isinstance(r, complex) or (isinstance(r, float) and abs(r) > 1e300):
            raise ExpressionError("Result out of range")
        return r
    if isinstance(node, ast.UnaryOp) and type(node.op) in _UNARY:
        return _UNARY[type(node.op)](_eval(node.operand, variables))
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in _FUNCS and not node.keywords:
        args = [_eval(a, variables) for a in node.args]
        return float(_FUNCS[node.func.id](*args))
    raise ExpressionError(f"Unsupported expression element: {type(node).__name__}")


def variables_in(expr: str) -> list[str]:
    tree = parse(expr)
    names = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)}
    return sorted(names - set(_FUNCS) - set(_CONSTS))


def parse(expr: str) -> ast.Expression:
    if not isinstance(expr, str) or not expr.strip():
        raise ExpressionError("Empty expression")
    if len(expr) > MAX_LEN:
        raise ExpressionError("Expression too long")
    try:
        return ast.parse(expr, mode="eval")
    except SyntaxError as e:
        raise ExpressionError(f"Syntax error: {e.msg}") from e


def evaluate(expr: str, variables: dict[str, float]) -> float:
    tree = parse(expr)
    try:
        return _eval(tree, variables)
    except ZeroDivisionError as e:
        raise ExpressionError("Division by zero") from e
    except (OverflowError, ValueError) as e:
        if isinstance(e, ExpressionError):
            raise
        raise ExpressionError(f"Math error: {e}") from e
