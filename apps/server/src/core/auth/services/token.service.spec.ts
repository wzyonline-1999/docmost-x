import { TokenService } from './token.service';

describe('TokenService', () => {
  let service: TokenService;
  const dependency = {} as never;

  beforeEach(() => {
    service = new TokenService(dependency, dependency);
  });

  it('should be defined', () => {
    expect(service).toBeInstanceOf(TokenService);
  });
});
