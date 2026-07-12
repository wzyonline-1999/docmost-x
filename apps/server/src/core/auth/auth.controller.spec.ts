import { AuthController } from './auth.controller';

describe('AuthController', () => {
  let controller: AuthController;
  const dependency = {} as never;

  beforeEach(() => {
    controller = new AuthController(
      dependency,
      dependency,
      dependency,
      dependency,
    );
  });

  it('should be defined', () => {
    expect(controller).toBeInstanceOf(AuthController);
  });
});
