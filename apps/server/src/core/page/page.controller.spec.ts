import { PageController } from './page.controller';

describe('PageController', () => {
  let controller: PageController;
  const dependency = {} as never;

  beforeEach(() => {
    controller = new PageController(
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
    expect(controller).toBeInstanceOf(PageController);
  });
});
