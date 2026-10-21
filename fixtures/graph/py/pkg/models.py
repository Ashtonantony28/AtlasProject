from pkg.util import helper


class Base:
    def save(self):
        return self.validate()

    def validate(self):
        return helper()


class User(Base):
    def create(self):
        return self.save()
