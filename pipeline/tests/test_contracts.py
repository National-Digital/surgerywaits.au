import pytest


@pytest.mark.skip(reason="planned: each manifest entry pins a publicdata slug, version and sha256")
def test_manifest_entry_pins_slug_version_and_sha256() -> None:
    raise NotImplementedError


@pytest.mark.skip(reason="planned: a download whose digest does not match fails closed")
def test_download_with_wrong_digest_fails_closed() -> None:
    raise NotImplementedError


@pytest.mark.skip(reason="planned: every null carries a publisher marker or is reported")
def test_every_null_has_a_publisher_marker_or_is_reported() -> None:
    raise NotImplementedError


@pytest.mark.skip(reason="planned: every publisher marker maps to one of the three reasons")
def test_every_marker_maps_to_one_of_three_reasons() -> None:
    raise NotImplementedError


@pytest.mark.skip(reason="planned: an unmatched or ambiguous hospital join fails the build")
def test_unmatched_or_ambiguous_hospital_join_fails() -> None:
    raise NotImplementedError


@pytest.mark.skip(reason="planned: every source licence is on the allow-list")
def test_licence_is_on_the_allow_list() -> None:
    raise NotImplementedError


@pytest.mark.skip(reason="planned: building the pipeline twice gives byte-identical dist")
def test_building_twice_gives_byte_identical_dist() -> None:
    raise NotImplementedError


@pytest.mark.skip(reason="planned: no wall-clock value lands in dist")
def test_no_wall_clock_values_in_dist() -> None:
    raise NotImplementedError


@pytest.mark.skip(reason="planned: the private sector is excluded")
def test_private_sector_is_excluded() -> None:
    raise NotImplementedError


@pytest.mark.skip(reason="planned: coordinates fall within Australia")
def test_coordinates_fall_within_australia() -> None:
    raise NotImplementedError


@pytest.mark.skip(reason="planned: slugs are unique")
def test_slugs_are_unique() -> None:
    raise NotImplementedError
