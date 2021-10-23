# Assembly

Assembly is a tool to enable DAO contributors to effectively re-imburse and pay
contributors for their work while ensuring full transparency.

At the beginning of each period every core contributor receives a token grant
from the DAO in "dist" tokens. These tokens can not be sold and represent the
budget allowance of each contributor for the period. Every contributor can spend
their budget by burning the dist tokens assigned to them. They can not spend the
budget on themselves.

Every grant is represented by a transfer of "grant" tokens that can be 1 for 1
redeemed for compensation at the end of the period, extended by a grace period
in which the DAO can freeze accounts in case funds have been misappropriated. In
order to allow for oversight through all DAO members every grant needs to be
marked with a short note on why this expense was necessary.

Compensation is initially only a single SPL token per distributor. Multiple
distributors can be used in parallel to account for grants in different types of
tokens. More complex payment schemes should be possible to add and all
submissions with sufficient test coverage are welcome.

## Project Structure

This project was written in [anchor](https://project-serum.github.io/anchor) to
allow easy customization and integration with more advanced compensation
primitives like vesting tokens or options.

`programs/assembly` - the on-chain program written in rust

`lib` - the typescript client library

`tests` - integration tests in typescript exercising both of the above

## Open Issues

1. Build a great GUI
2. Integrate into governance-ui so we can fund it from the DAO
3. Add instruction to return excess budget to DAO
4. Close intermediate token accounts and refund SOL
