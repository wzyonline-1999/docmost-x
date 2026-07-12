import { PageService } from './page.service';

describe('PageService', () => {
  let service: PageService;
  const dependency = {} as never;

  beforeEach(() => {
    service = new PageService(
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
      dependency,
    );
  });

  it('should be defined', () => {
    expect(service).toBeInstanceOf(PageService);
  });
});
