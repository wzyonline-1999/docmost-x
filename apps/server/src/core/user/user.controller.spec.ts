import { UserController } from './user.controller';

describe('UserController', () => {
  let controller: UserController;
  const dependency = {} as never;

  beforeEach(() => {
    controller = new UserController(dependency, dependency);
  });

  it('should be defined', () => {
    expect(controller).toBeInstanceOf(UserController);
  });
});
