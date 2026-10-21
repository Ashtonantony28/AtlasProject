import pkg.util
from ..util import other
from ..models import User
from . import tools


def run():
    # helper() and format_it() are only mentioned here
    note = "other() inside a string"
    user = User()
    user.create()
    tools.format_it(note)
    pkg.util.helper()
    return other()


def decoy():
    """Calls run() only in this docstring."""
    # run()
    return "run()"
