# Shelf backlog

These stories are settled. Yours, SH-5, is the one still missing.

## SH-1 Browse the shelf
As a member, I want to see every book in shelf order, so that I can find one without asking.
- AC-1 Given books with different titles, When I open the shelf, Then they are listed by title.
- AC-2 Given books by several authors, When I filter by an author in any case, Then only that author's books are listed.

## SH-2 Lend a book
As a librarian, I want to record who has borrowed a book, so that I know where it is.
- AC-1 Given a book on the shelf, When I lend it to a member, Then the book says who has it.
- AC-2 Given a book already on loan, When I try to lend it again, Then the loan is refused.

## SH-3 Return a book
As a librarian, I want to put a returned book back, so that the next member can borrow it.
- AC-1 Given a book on loan, When it is returned, Then it is on the shelf again.
- AC-2 Given an id no book has, When it is returned, Then the request is refused as not found.

## SH-4 See what is out
As a member, I want the shelf to say which books are on loan, so that I do not walk to an empty space.
- AC-1 Given a book on loan, When I read its line, Then the line ends "on loan".
