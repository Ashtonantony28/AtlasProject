from typing import Generic, TypeVar

from pkg.api import view, starred
from .models import Base

T = TypeVar("T")


class Repo(Generic[T]):
    def get(self):
        return view()


class UserRepo(Repo["User"], Base):
    def all(self):
        self.save()
        return self.get()


def lazy():
    from .util import helper

    return helper() + starred()
