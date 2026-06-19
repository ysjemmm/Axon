"""一个简单的四则运算计算器模块。"""


class Calculator:
    """提供加、减、乘、除四种基本运算的计算器类。"""

    def add(self, a: float, b: float) -> float:
        """返回 a 与 b 的和。

        Args:
            a: 第一个加数。
            b: 第二个加数。

        Returns:
            a + b 的结果。
        """
        return a + b

    def subtract(self, a: float, b: float) -> float:
        """返回 a 减去 b 的差。

        Args:
            a: 被减数。
            b: 减数。

        Returns:
            a - b 的结果。
        """
        return a - b

    def multiply(self, a: float, b: float) -> float:
        """返回 a 与 b 的乘积。

        Args:
            a: 第一个乘数。
            b: 第二个乘数。

        Returns:
            a * b 的结果。
        """
        return a * b

    def divide(self, a: float, b: float) -> float:
        """返回 a 除以 b 的商。

        Args:
            a: 被除数。
            b: 除数。

        Returns:
            a / b 的结果。

        Raises:
            ValueError: 当除数 b 为零时抛出。
        """
        if b == 0:
            raise ValueError("除数不能为零")
        return a / b


if __name__ == "__main__":
    calc = Calculator()

    print("===== 四则运算演示 =====")
    print(f"10 + 3  = {calc.add(10, 3)}")
    print(f"10 - 3  = {calc.subtract(10, 3)}")
    print(f"10 * 3  = {calc.multiply(10, 3)}")
    print(f"10 / 3  = {calc.divide(10, 3):.4f}")

    # 除零安全演示
    try:
        calc.divide(10, 0)
    except ValueError as e:
        print(f"10 / 0  → 捕获异常: {e}")
