import ast
import operator
import re
from numbers import Real


class ExpressionError(ValueError):
    pass


_BINARY_OPERATORS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
}
_UNARY_OPERATORS = {
    ast.UAdd: operator.pos,
    ast.USub: operator.neg,
}
_VALID_EXPRESSION = re.compile(r"[0-9.+\-*/()%]+")
_EXPRESSION_STOP_MARKERS = re.compile(r"[=≈≃≅~？?]")
_FULLWIDTH_TRANSLATION = str.maketrans(
    {
        "０": "0",
        "１": "1",
        "２": "2",
        "３": "3",
        "４": "4",
        "５": "5",
        "６": "6",
        "７": "7",
        "８": "8",
        "９": "9",
        "＋": "+",
        "－": "-",
        "×": "*",
        "✕": "*",
        "＊": "*",
        "÷": "/",
        "／": "/",
        "（": "(",
        "）": ")",
        "．": ".",
    }
)


def normalize_expression(raw_text: str) -> str:
    expression = raw_text.translate(_FULLWIDTH_TRANSLATION)
    expression = expression.replace("x", "*").replace("X", "*")
    expression = _EXPRESSION_STOP_MARKERS.split(expression, 1)[0]
    expression = re.sub(r"\s+", "", expression)
    if not expression or not _VALID_EXPRESSION.fullmatch(expression):
        raise ExpressionError("Expression contains unrecognized characters")
    if not expression or len(expression) > 100:
        raise ExpressionError("No valid arithmetic expression was found")
    return expression


def _evaluate_node(node: ast.AST) -> Real:
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return node.value

    if isinstance(node, ast.UnaryOp) and type(node.op) in _UNARY_OPERATORS:
        return _UNARY_OPERATORS[type(node.op)](_evaluate_node(node.operand))

    if isinstance(node, ast.BinOp) and type(node.op) in _BINARY_OPERATORS:
        left = _evaluate_node(node.left)
        right = _evaluate_node(node.right)
        if isinstance(node.op, ast.Div) and right == 0:
            raise ExpressionError("Division by zero")
        return _BINARY_OPERATORS[type(node.op)](left, right)

    raise ExpressionError("Expression contains an unsupported operator")


def evaluate_expression(raw_text: str) -> tuple[str, Real]:
    expression = normalize_expression(raw_text)
    try:
        tree = ast.parse(expression, mode="eval")
        result = _evaluate_node(tree.body)
    except (SyntaxError, ValueError, TypeError, ZeroDivisionError) as exc:
        raise ExpressionError("Invalid arithmetic expression") from exc

    if not isinstance(result, Real):
        raise ExpressionError("Expression did not produce a number")
    if isinstance(result, float) and result.is_integer():
        result = int(result)
    return expression, result
