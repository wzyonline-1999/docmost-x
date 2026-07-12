import { AuthService } from './auth.service';

describe('AuthService', () => {
  let service: AuthService;
  const dependency = {} as never;

  beforeEach(() => {
    service = new AuthService(
      dependency,
      dependency,
      dependency,
      dependency,
      dependency,
      dependency,
      dependency,
      dependency,
      dependency,
      dependency,
      dependency,
    );
  });

  it('should be defined', () => {
    expect(service).toBeInstanceOf(AuthService);
  });
});
