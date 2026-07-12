import { SpaceService } from './space.service';

describe('SpaceService', () => {
  let service: SpaceService;
  const dependency = {} as never;

  beforeEach(() => {
    service = new SpaceService(
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
    expect(service).toBeInstanceOf(SpaceService);
  });
});
