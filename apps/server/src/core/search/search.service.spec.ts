import { SearchService } from './search.service';

describe('SearchService', () => {
  let service: SearchService;
  const dependency = {} as never;

  beforeEach(() => {
    service = new SearchService(
      dependency,
      dependency,
      dependency,
      dependency,
      dependency,
    );
  });

  it('should be defined', () => {
    expect(service).toBeInstanceOf(SearchService);
  });
});
