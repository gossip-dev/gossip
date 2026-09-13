// Synthetic local-only contracts for DEX calldata tests; these are not Uniswap deployments.
pragma solidity ^0.8.24;

contract DexToken {
    string public name = "Synthetic";
    string public symbol = "SYN";
    uint8 public decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function approve(address spender, uint256 amount) external returns (bool) { allowance[msg.sender][spender] = amount; return true; }
    function transfer(address to, uint256 amount) external returns (bool) { _move(msg.sender, to, amount); return true; }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "allowance");
        allowance[from][msg.sender] = allowed - amount;
        _move(from, to, amount);
        return true;
    }
    function _move(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

contract DexPool {}

contract DexFactory {
    address public immutable pool;
    constructor(address pool_) { pool = pool_; }
    function getPool(address, address, uint24) external view returns (address) { return pool; }
}

contract DexQuoter {
    struct QuoteParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }
    function quoteExactInputSingle(QuoteParams calldata params)
        external pure returns (uint256,uint160,uint32,uint256)
    { return (params.amountIn * 2, 0, 0, 100000); }
}

contract DexRouter {
    struct Params { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }
    function multicall(uint256 deadline, bytes[] calldata data) external returns (bytes[] memory results) {
        require(block.timestamp <= deadline, "expired");
        results = new bytes[](data.length);
        for (uint256 i = 0; i < data.length; i++) {
            (bool ok, bytes memory result) = address(this).delegatecall(data[i]);
            if (!ok) assembly { revert(add(result, 32), mload(result)) }
            results[i] = result;
        }
    }
    function exactInputSingle(Params calldata params) external returns (uint256 amountOut) {
        require(params.fee == 3000, "fee");
        require(params.amountIn >= 1, "amount");
        require(DexToken(params.tokenIn).transferFrom(msg.sender, address(this), params.amountIn), "input");
        amountOut = params.amountIn * 2;
        require(amountOut >= params.amountOutMinimum, "minout");
        DexToken(params.tokenOut).mint(params.recipient == address(1) ? msg.sender : params.recipient, amountOut);
    }
}
