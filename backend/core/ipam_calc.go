package core

import (
	"fmt"
	"math/big"
	"math/bits"
	"net/netip"
	"sort"
)

func ValidateStrictCIDR(cidrStr string) (netip.Prefix, error) {
	prefix, err := netip.ParsePrefix(cidrStr)
	if err != nil {
		return netip.Prefix{}, codedf("ipam.invalid_cidr", nil, "无效的 CIDR 格式: %v", err)
	}

	masked := prefix.Masked()
	if masked != prefix {
		return netip.Prefix{}, codedf("ipam.cidr_not_canonical",
			map[string]string{"suggest": masked.String()},
			"地址不标准，您需要的是否是 %s？", masked.String())
	}

	return prefix, nil
}

func ipToBigInt(ip netip.Addr) *big.Int {
	if ip.Is4() {
		b := ip.As4()
		return big.NewInt(0).SetBytes(b[:])
	}
	b := ip.As16()
	return big.NewInt(0).SetBytes(b[:])
}

func bigIntToIP(i *big.Int, is4 bool) (netip.Addr, error) {
	if is4 {
		var b [4]byte
		i.FillBytes(b[:])
		addr, ok := netip.AddrFromSlice(b[:])
		if !ok {
			return netip.Addr{}, fmt.Errorf("无效的 IPv4 地址字节序列")
		}
		return addr, nil
	}
	var b [16]byte
	i.FillBytes(b[:])
	addr, ok := netip.AddrFromSlice(b[:])
	if !ok {
		return netip.Addr{}, fmt.Errorf("无效的 IPv6 地址字节序列")
	}
	return addr, nil
}

func CalculateSplitSubnets(cidr string, targetBits int) ([]string, error) {
	prefix, err := ValidateStrictCIDR(cidr)
	if err != nil {
		return nil, err
	}

	if targetBits <= prefix.Bits() {
		return nil, codedf("ipam.split_bits_too_small",
			map[string]string{"target": fmt.Sprint(targetBits), "current": fmt.Sprint(prefix.Bits())},
			"目标掩码 /%d 必须大于当前掩码 /%d", targetBits, prefix.Bits())
	}

	maxBits := prefix.Addr().BitLen()
	if targetBits > maxBits {
		return nil, codedf("ipam.split_bits_out_of_range",
			map[string]string{"target": fmt.Sprint(targetBits)},
			"目标掩码 /%d 超出合法范围", targetBits)
	}

	shift := targetBits - prefix.Bits()
	if shift > 16 {
		return nil, codedf("ipam.split_too_many", nil, "单次拆分生成的网段数量过多（上限 65536）")
	}

	count := 1 << shift
	subnets := make([]string, 0, count)

	ipInt := ipToBigInt(prefix.Addr())
	step := big.NewInt(1)
	step.Lsh(step, uint(maxBits-targetBits))

	for i := 0; i < count; i++ {
		addr, _ := bigIntToIP(ipInt, prefix.Addr().Is4())
		newPrefix := netip.PrefixFrom(addr, targetBits)
		subnets = append(subnets, newPrefix.String())

		ipInt.Add(ipInt, step)
	}

	return subnets, nil
}

func CalculateMergeSubnets(cidrList []string) (string, error) {
	if len(cidrList) < 2 {
		return "", codedf("ipam.merge_min_two", nil, "至少需要选择两个子网进行合并")
	}

	var prefixes []netip.Prefix
	for _, cidr := range cidrList {
		prefix, err := ValidateStrictCIDR(cidr)
		if err != nil {
			return "", err
		}
		prefixes = append(prefixes, prefix)
	}

	is4 := prefixes[0].Addr().Is4()
	maskBits := prefixes[0].Bits()

	for _, p := range prefixes {
		if p.Addr().Is4() != is4 {
			return "", codedf("ipam.merge_family_mismatch", nil, "所选子网的 IP 版本不一致")
		}
		if p.Bits() != maskBits {
			return "", codedf("ipam.merge_mask_mismatch", nil, "所选子网的掩码长度必须相同")
		}
	}

	count := len(prefixes)
	if count&(count-1) != 0 {
		return "", codedf("ipam.merge_not_power_of_two",
			map[string]string{"count": fmt.Sprint(count)},
			"所选子网数量 (%d) 不是 2 的整数次幂，无法合并为标准网段", count)
	}

	sort.Slice(prefixes, func(i, j int) bool {
		return prefixes[i].Addr().Compare(prefixes[j].Addr()) < 0
	})

	shift := bits.TrailingZeros(uint(count))
	targetBits := maskBits - shift
	if targetBits < 0 {
		return "", fmt.Errorf("合并后的掩码不合法")
	}

	targetPrefix := netip.PrefixFrom(prefixes[0].Addr(), targetBits)
	if targetPrefix.Masked() != targetPrefix {
		return "", codedf("ipam.merge_not_adjacent", nil, "所选子网不相邻或无法构成标准聚合网段")
	}

	ipInt := ipToBigInt(prefixes[0].Addr())
	maxBits := prefixes[0].Addr().BitLen()
	step := big.NewInt(1)
	step.Lsh(step, uint(maxBits-maskBits))

	for i := 0; i < count; i++ {
		expectedAddr, _ := bigIntToIP(ipInt, is4)
		if prefixes[i].Addr() != expectedAddr {
			return "", codedf("ipam.merge_not_adjacent", nil, "所选子网不相邻或缺失片段，无法构成标准聚合网段")
		}
		ipInt.Add(ipInt, step)
	}

	return targetPrefix.String(), nil
}
