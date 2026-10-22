from .util import helper


def on_start():
    pass


HOOKS = [on_start]


def register(app):
    app.add(callback=helper)
    return on_start
