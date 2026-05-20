"""Tiny Python helper module used by the fixture."""


def greet(name: str) -> str:
    """Return a friendly greeting."""
    return f"Hello, {name}!"


class Counter:
    """A trivial counter to exercise class extraction."""

    def __init__(self, start: int = 0) -> None:
        self.value = start

    def increment(self, by: int = 1) -> int:
        """Increment and return the new value."""
        self.value += by
        return self.value
