import { SearchController } from './search.controller';

describe('SearchController', () => {
  let controller: SearchController;
  const dependency = {} as never;

  beforeEach(() => {
    controller = new SearchController(dependency, dependency, dependency);
  });

  it('should be defined', () => {
    expect(controller).toBeInstanceOf(SearchController);
  });
});
